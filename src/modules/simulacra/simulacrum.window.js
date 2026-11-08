// Ventana de un simulacro programado. Funciones puras (sin Mongo).
//
// Port del monolito (`eduteka/src/libs/simulacrum_window.js`): mismos nombres y
// mismas tablas de verdad, para que los dos repositorios se mantengan paralelos.
// Si una copia cambia, la otra cambia en el mismo PR (ver test/simulacra_window.test.js).
//
//   registration: inscripcion abierta (antes de register_close_date)
//   waiting:      inscripcion cerrada, aun no empieza
//   live:         entre start_date y end_date
//   finished:     paso end_date o el simulacro esta cerrado (finished)
//
// Programado <=> start_date y end_date definidos. El flag `automatic` no decide nada.

export const PHASES = Object.freeze({
    REGISTRATION: 'registration',
    WAITING: 'waiting',
    LIVE: 'live',
    FINISHED: 'finished',
});

const time = (value) => {
    if (!value) return null;
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
};

const iso = (value) => {
    const t = time(value);
    return t === null ? null : new Date(t).toISOString();
};

export const isScheduled = (sim) => time(sim?.start_date) !== null && time(sim?.end_date) !== null;

export const getPhase = (sim, now = new Date()) => {
    const t = new Date(now).getTime();
    if (sim?.finished) return PHASES.FINISHED;
    if (!isScheduled(sim)) return PHASES.LIVE;

    const start = time(sim.start_date);
    const end = time(sim.end_date);
    const close = time(sim.register_close_date) ?? start;

    if (t >= end) return PHASES.FINISHED;
    if (t >= start) return PHASES.LIVE;
    if (t < close && sim.for_register !== false) return PHASES.REGISTRATION;
    return PHASES.WAITING;
};

/** Inscripcion permitida. Un simulacro sin programar solo depende de for_register. */
export const canRegister = (sim, now = new Date()) => {
    if (sim?.for_register === false || sim?.finished) return false;
    if (!isScheduled(sim)) return true;
    return getPhase(sim, now) === PHASES.REGISTRATION;
};

/** Puede abrir el examen por primera vez. */
export const canStart = (sim, now = new Date()) => getPhase(sim, now) === PHASES.LIVE;

/** Instante limite de un intento: lo que reste de la duracion, sin pasar de end_date. */
export const attemptDeadline = (sim, startedAt, durationMin) => {
    const own = new Date(startedAt).getTime() + durationMin * 60 * 1000;
    const end = isScheduled(sim) ? time(sim.end_date) : null;
    return new Date(end === null ? own : Math.min(own, end));
};

/** Hora de publicacion de resultados: results_public_at, o el fin de la ventana. */
export const resultsAt = (sim) => sim?.results_public_at ?? sim?.end_date ?? null;

/**
 * Resultados publicados. En un programado solo `public_results === true` cuenta (un
 * simulacro recien creado, con el campo sin definir, no publica durante la ventana);
 * en el resto se mantiene la regla historica `!== false`.
 */
export const resultsPublished = (sim) => (isScheduled(sim) ? sim?.public_results === true : sim?.public_results !== false);

/** Horario tal como lo sirve la API (fechas ISO). null si no esta programado. */
export const scheduleView = (sim, now = new Date()) => {
    if (!isScheduled(sim)) return null;
    const phase = getPhase(sim, now);
    return {
        phase,
        registration_open: phase === PHASES.REGISTRATION,
        register_close_date: iso(sim.register_close_date ?? sim.start_date),
        start_date: iso(sim.start_date),
        end_date: iso(sim.end_date),
        results_at: iso(resultsAt(sim)),
        results_published: resultsPublished(sim),
    };
};
