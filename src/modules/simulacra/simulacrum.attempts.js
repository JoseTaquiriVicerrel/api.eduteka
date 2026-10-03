import { randomUUID } from 'node:crypto';
import SimulacrumAttemptModel from '#Models/simulacrum_attempt_model.js';
import UserSimulacrumModel from '#Models/user_simulacrum_model.js';
import { attemptNumberOf } from './simulacrum.state.js';

// Archivo de intentos y reinicio para un reintento. Port de
// simulacrum_attempt.service.js del monolito.

/**
 * Campos del intento que se copian al archivo.
 *
 * `ai_analysis` NO esta y no debe estarlo: pese al nombre guarda el analisis del
 * COMPROBANTE DE PAGO de la inscripcion; archivarlo y limpiarlo borraria la evidencia.
 */
const ATTEMPT_FIELDS = [
    'answers', 'start_exam', 'end_exam', 'exam_finished', 'time',
    'score', 'score_conversion', 'results',
    'questions_correct', 'questions_incorrect', 'questions_not_answered',
];

// Lo unico que se borra al empezar un intento nuevo. El puntaje del anterior se deja
// hasta que el nuevo termine: abrir /resultados a mitad del reintento no debe
// calificar con cero respuestas encima del resultado anterior.
const RESET_FIELDS = ['start_exam', 'end_exam', 'exam_finished'];

// En Mongo `{campo: null}` casa tambien con "ausente": el intento 1 cubre a las filas
// anteriores a los reintentos, que no tienen el contador.
export const attemptFilter = (number) => (number === 1 ? { $in: [1, null] } : number);

/**
 * Congela el intento CERRADO en el archivo. Es un upsert por
 * (inscripcion, numero de intento), que ademas tiene indice unico: repetirlo no
 * duplica nada. Un intento abierto no se archiva.
 */
export const archiveAttempt = async (enrollment) => {
    if (!enrollment?.finished) return;

    const snapshot = {
        user_id: enrollment.user_id,
        simulacrum_id: enrollment.simulacrum_id,
        area: enrollment.area,
        career: enrollment.career,
    };
    for (const field of ATTEMPT_FIELDS) {
        if (enrollment[field] !== undefined) snapshot[field] = enrollment[field];
    }

    await SimulacrumAttemptModel.updateOne(
        { user_simulacrum_id: enrollment._id, attempt_number: attemptNumberOf(enrollment) },
        { $set: snapshot, $setOnInsert: { _id: randomUUID() } },
        { upsert: true },
    ).exec();
};

/**
 * Deja la inscripcion lista para un intento nuevo.
 *
 * Toda la carrera se decide en un unico findOneAndUpdate condicionado a
 * `finished: true` y al numero de intento leido: de dos peticiones simultaneas solo
 * una encuentra el documento en ese estado; la otra recibe `null` ("alguien ya lo
 * hizo"). Las fechas se quitan con $unset y no con null: comparar contra null daria
 * "ya vencio".
 *
 * @returns {Promise<object|null>} la inscripcion reiniciada, o null si otra peticion se adelanto.
 */
export const startNewAttempt = async (enrollment) => {
    // Red de seguridad para inscripciones anteriores a los reintentos.
    await archiveAttempt(enrollment);

    // Congelacion tardia del ranking: justo aqui su `score` sigue siendo el del primer intento.
    const freeze = {};
    if (enrollment.official_score === undefined || enrollment.official_score === null) {
        if (enrollment.score !== undefined) freeze.official_score = enrollment.score;
        if (enrollment.score_conversion !== undefined) freeze.official_score_conversion = enrollment.score_conversion;
    }

    const current = attemptNumberOf(enrollment);
    return UserSimulacrumModel.findOneAndUpdate(
        { _id: enrollment._id, finished: true, state: true, attempt_number: attemptFilter(current) },
        {
            $set: { ...freeze, answers: {}, finished: false, attempt_number: current + 1 },
            $unset: Object.fromEntries(RESET_FIELDS.map((field) => [field, ''])),
        },
        { new: true },
    ).lean().exec();
};

/**
 * Historial completo, del intento mas reciente al mas antiguo. El vigente tambien
 * puede estar archivado: se indexa por numero y gana la version viva, que ademas
 * cubre a las inscripciones heredadas (cerradas pero nunca archivadas).
 */
export const listAttempts = async (enrollment) => {
    if (!enrollment) return [];

    const archived = await SimulacrumAttemptModel.find({ user_simulacrum_id: enrollment._id }).lean().exec();
    const byNumber = new Map(archived.map((attempt) => [attempt.attempt_number, { ...attempt, is_current: false }]));

    if (enrollment.finished) {
        const number = attemptNumberOf(enrollment);
        const current = { attempt_number: number, is_current: true, area: enrollment.area, career: enrollment.career };
        for (const field of ATTEMPT_FIELDS) current[field] = enrollment[field];
        byNumber.set(number, current);
    }

    return [...byNumber.values()].sort((a, b) => b.attempt_number - a.attempt_number);
};
