// Estado de un simulacro y de la inscripcion de un postulante. Funciones puras
// (reciben documentos ya cargados y el instante actual) para poder probarlas sin base.
//
// Modelo de datos (heredado del monolito):
//   - UserSimulacrum es la INSCRIPCION y, a la vez, el intento VIVO: guarda las
//     respuestas, el cronometro (start_exam/end_exam) y la nota del ultimo intento.
//   - SimulacrumAttempt es el ARCHIVO de solo lectura de los intentos ya cerrados.
//   - Un reintento reinicia la inscripcion con attempt_number + 1.
//
// Dos modos de simulacro:
//   - automatic: evento con hora de inicio y fin globales (start_date..end_date).
//   - bajo demanda: cada postulante arranca su propio cronometro al iniciar.

import { PHASES, getPhase, isScheduled } from './simulacrum.window.js';

export const attemptNumberOf = (enrollment) => enrollment?.attempt_number ?? 1;

/** Un reintento (intento > 1) abierto: unica razon para entrar a un simulacro ya cerrado. */
export const isRetryInProgress = (enrollment) => (
    Boolean(enrollment) && attemptNumberOf(enrollment) > 1 && enrollment.finished !== true
);

const toTime = (value) => {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
};

/** Al intento vivo se le acabo el tiempo y nadie lo cerro. */
export const attemptExpired = (enrollment, now = new Date()) => {
    const end = toTime(enrollment?.end_exam);
    return Boolean(enrollment?.start_exam) && enrollment.finished !== true && end !== null && now.getTime() > end;
};

/**
 * El simulacro admite sumar ranking: solo el PRIMER intento cuenta para la tabla
 * publica, asi volver a rendir no reordena un ranking que los demas rindieron una vez.
 */
export const freezesOfficialScore = (enrollment) => attemptNumberOf(enrollment) <= 1;

/** `general` por defecto es true (default del esquema): una fila sin el campo es general. */
export const isGeneral = (simulacrum) => simulacrum?.general !== false;

const areaHasQuestions = (simulacrum, enrollment) => {
    if (isGeneral(simulacrum)) return true;
    const area = simulacrum.areas?.[enrollment.area];
    // La ficha ligera trae el conteo en lugar de las preguntas.
    return (area?.questions?.length ?? area?.questions_count ?? 0) > 0;
};

/** Motivo por el que NO se puede volver a rendir, o null si se puede. */
export const retryBlockedReason = (enrollment, simulacrum) => {
    if (!enrollment) return 'No estás inscrito en este simulacro';
    if (!enrollment.state) return 'Tu inscripción todavía no ha sido verificada';
    if (!enrollment.finished) return 'Todavía tienes un intento en curso';
    if (!simulacrum?.verified) return 'Este simulacro ya no está disponible para volver a rendir';
    if (!areaHasQuestions(simulacrum, enrollment)) return 'El área en la que te inscribiste ya no está disponible en este simulacro';
    return null;
};

/**
 * upcoming | live | finished.
 *  - Programado (start_date y end_date definidos): por fase. registration y waiting son
 *    `upcoming`. El flag `automatic` no decide nada (contrato §1).
 *  - Sin programar:
 *      finished: cerrado por el administrador, o evento cuya hora de fin ya paso.
 *      upcoming: evento (`automatic`) que aun no empezo (sin fecha de inicio o inicio futuro).
 *      live: todo lo demas (los simulacros bajo demanda estan siempre abiertos).
 */
export const simulacrumStatus = (simulacrum, now = new Date()) => {
    if (isScheduled(simulacrum)) {
        const phase = getPhase(simulacrum, now);
        if (phase === PHASES.FINISHED) return 'finished';
        return phase === PHASES.LIVE ? 'live' : 'upcoming';
    }

    const end = toTime(simulacrum.end_date);
    if (simulacrum.finished === true) return 'finished';
    if (!simulacrum.automatic) return 'live';
    if (end !== null && now.getTime() > end) return 'finished';

    const start = toTime(simulacrum.start_date);
    if (start === null || now.getTime() < start) return 'upcoming';
    return 'live';
};

/** Estado del postulante respecto al simulacro (el mismo criterio que la ficha de la web). */
export const enrollmentState = (simulacrum, enrollment, now = new Date()) => {
    if (!enrollment) return 'unregistered';

    const end = toTime(enrollment.end_exam);
    const ended = end !== null && end < now.getTime();

    if (isRetryInProgress(enrollment)) {
        if (!enrollment.start_exam) return 'registered';
        return ended ? 'finished' : 'in_progress';
    }

    // Programado: registered hasta que abre la ventana; despues in_progress solo si ya empezo.
    if (isScheduled(simulacrum)) {
        if (enrollment.finished) return 'finished';
        const phase = getPhase(simulacrum, now);
        if (phase === PHASES.FINISHED) return 'finished';
        if (phase === PHASES.LIVE && enrollment.start_exam) return ended ? 'finished' : 'in_progress';
        return 'registered';
    }

    if (simulacrum.automatic) {
        if (simulacrum.finished || enrollment.finished) return 'finished';
        if (simulacrum.start_date && simulacrum.end_date) {
            return toTime(simulacrum.end_date) < now.getTime() ? 'finished' : 'in_progress';
        }
        return 'registered';
    }

    if (enrollment.finished) return 'finished';
    if (enrollment.start_exam && enrollment.end_exam) return ended ? 'finished' : 'in_progress';
    return 'registered';
};

/**
 * Si se puede abrir el examen por primera vez ahora. null = si; si no, { code, message }.
 *  - Programado: por fase (NOT_STARTED antes de start_date, WINDOW_ENDED desde end_date o si esta cerrado).
 *  - Sin programar: sin ventana, salvo un evento (`automatic`) sin fechas, que sigue sin abrir (NOT_STARTED).
 */
export const startWindowViolation = (simulacrum, now = new Date()) => {
    const notStarted = { code: 'NOT_STARTED', message: 'El simulacro todavía no ha comenzado.' };
    const ended = { code: 'WINDOW_ENDED', message: 'El simulacro ya cerró.' };

    if (isScheduled(simulacrum)) {
        const phase = getPhase(simulacrum, now);
        if (phase === PHASES.LIVE) return null;
        return phase === PHASES.FINISHED ? ended : notStarted;
    }

    if (!simulacrum.automatic) return null;

    const start = toTime(simulacrum.start_date);
    const end = toTime(simulacrum.end_date);
    if (start === null || now.getTime() < start) return notStarted;
    if (end !== null && now.getTime() > end) return ended;
    return null;
};
