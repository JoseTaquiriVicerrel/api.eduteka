// Cierre de la ventana de un simulacro programado: solo Mongo, sin colas ni sockets.
//
// Port de `closeWindow`, `markAbsent` y `publishResults` del monolito
// (eduteka/src/libs/simulacrum_realtime.js), con una diferencia deliberada: cada intento se
// califica con `gradeAndClose`, el MISMO cierre que usa POST /simulacros/intentos/:id/finalizar.
// Asi deja de haber dos calificadores escribiendo las mismas filas.
//
// Todo es idempotente: repetirlo (reintento de la cola, reconciliacion, reinicio a medias) solo
// toca lo que sigue abierto.

import SimulacrumModel from '#Models/simulacrum_model.js';
import UserSimulacrumModel from '#Models/user_simulacrum_model.js';
import { gradeAndClose } from '../simulacrum.service.js';
import { isRetryInProgress } from '../simulacrum.state.js';
import { isScheduled, resultsDue } from '../simulacrum.window.js';

/**
 * Inscritos aprobados que nunca abrieron el examen (intento 1): quedan `ausent`. Un reintento
 * (intento >= 2) sin empezar no es un ausente. Devuelve cuantos se marcaron.
 */
export const markAbsent = async (simulacrumId) => {
    const result = await UserSimulacrumModel.updateMany({
        simulacrum_id: simulacrumId,
        state: true,
        finished: { $ne: true },
        start_exam: null,
        attempt_number: { $in: [1, null] },
        ausent: { $ne: true },
    }, { $set: { ausent: true } }).exec();
    return result.modifiedCount;
};

/** Ids de los intentos que siguen abiertos (empezados y sin cerrar). */
export const openAttemptIds = async (simulacrumId) => {
    const rows = await UserSimulacrumModel.find({
        simulacrum_id: simulacrumId,
        state: true,
        finished: { $ne: true },
        start_exam: { $ne: null },
    }, { _id: 1 }).lean().exec();
    return rows.map((row) => String(row._id));
};

/**
 * Califica y cierra un intento abierto al terminar la ventana.
 *
 * Devuelve 'graded', o el motivo por el que no hizo nada:
 *   'missing'  no existe (purgado)
 *   'closed'   ya estaba cerrado (lo cerro su dueño, u otro reintento de este trabajo)
 *   'retry'    es un reintento (practica con su propio cronometro): no se toca
 *   'unstarted' nunca empezo: es un ausente, no se califica
 */
export const gradeOpenAttempt = async ({ simulacrumId, userSimulacrumId, now = new Date() }) => {
    const enrollment = await UserSimulacrumModel.findById(userSimulacrumId).lean().exec();
    if (!enrollment || String(enrollment.simulacrum_id) !== String(simulacrumId)) return 'missing';
    if (enrollment.finished === true) return 'closed';
    if (isRetryInProgress(enrollment)) return 'retry';
    if (!enrollment.start_exam) return 'unstarted';

    const simulacrum = await SimulacrumModel.findById(simulacrumId).lean().exec();
    if (!simulacrum) return 'missing';

    // gradeAndClose recorta `exam_finished` y el tiempo a `end_exam`: nunca se cuenta tiempo de mas.
    const { graded } = await gradeAndClose({ simulacrum, enrollment, finishedAt: now });
    return graded ? 'graded' : 'closed';
};

/**
 * Publica los resultados: simulacro e inscripciones. Idempotente. Devuelve true si esta llamada
 * fue la que los publico (para avisar `results` una sola vez).
 */
export const publishResults = async (simulacrumId) => {
    const done = await SimulacrumModel.updateOne(
        { _id: simulacrumId, public_results: { $ne: true } },
        { $set: { public_results: true } },
    ).exec();
    await UserSimulacrumModel.updateMany(
        { simulacrum_id: simulacrumId, public_results: { $ne: true } },
        { $set: { public_results: true } },
    ).exec();
    return done.modifiedCount > 0;
};

/**
 * Ultimo paso del cierre, cuando ya se calificaron los intentos: marca el simulacro como cerrado
 * y publica los resultados si ya toca. Devuelve el simulacro actualizado y que paso.
 */
export const finalizeWindow = async (simulacrumId, now = new Date()) => {
    await SimulacrumModel.updateOne({ _id: simulacrumId, finished: { $ne: true } }, { $set: { finished: true } }).exec();
    const simulacrum = await SimulacrumModel.findById(simulacrumId).lean().exec();
    if (!simulacrum) return { simulacrum: null, published: false };

    const published = isScheduled(simulacrum) && resultsDue(simulacrum, now)
        ? await publishResults(simulacrumId)
        : false;
    const fresh = published ? await SimulacrumModel.findById(simulacrumId).lean().exec() : simulacrum;
    return { simulacrum: fresh, published };
};
