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

/**
 * Hitos que el servidor debe ejecutar, en orden: [{ kind, at (ms epoch) }]. Port literal de
 * `nextEvent` del monolito, pero devolviendo TODOS los futuros (el planificador de la API los
 * deja programados de una vez como trabajos diferidos; ver scheduler/simulacrum.scheduler.js).
 *
 *   close:   se cerro la inscripcion (solo si cierra antes del inicio)
 *   start:   abre la ventana
 *   end:     termina la ventana (se califica y se cierra)
 *   results: se publican los resultados, solo si results_public_at es posterior al fin;
 *            sin el, se publican al cerrar (ver resultsDue)
 *
 * Un simulacro cerrado a mano ya no tiene inicio ni fin que vigilar, pero sus resultados
 * programados siguen pendientes.
 */
export const upcomingEvents = (sim, now = new Date()) => {
    if (!isScheduled(sim)) return [];
    const t = new Date(now).getTime();
    const start = time(sim.start_date);
    const end = time(sim.end_date);
    const close = time(sim.register_close_date) ?? start;
    const results = time(sim.results_public_at);

    const events = [];
    if (!sim.finished) {
        if (close < start) events.push({ kind: 'close', at: close });
        events.push({ kind: 'start', at: start }, { kind: 'end', at: end });
    }
    if (sim.public_results !== true && results !== null && results > end) {
        events.push({ kind: 'results', at: results });
    }
    return events.filter((e) => e.at > t).sort((a, b) => a.at - b.at);
};

/** Proximo hito ({ kind, at }) o null. Misma firma y resultado que en el monolito. */
export const nextEvent = (sim, now = new Date()) => upcomingEvents(sim, now)[0] ?? null;

/**
 * Instante en que el simulacro tiene HOY programado el hito `kind` (ms epoch), o null si ya no
 * lo tiene. Un trabajo diferido se programo con el instante de entonces: si el admin cambio las
 * fechas, el trabajo viejo ya no coincide y se descarta sin hacer nada.
 */
export const milestoneAt = (sim, kind) => {
    if (!isScheduled(sim)) return null;
    const start = time(sim.start_date);
    if (kind === 'close') {
        const close = time(sim.register_close_date) ?? start;
        return close < start ? close : null;
    }
    if (kind === 'start') return start;
    if (kind === 'end') return time(sim.end_date);
    if (kind === 'results') {
        const results = time(sim.results_public_at);
        return results !== null && results > time(sim.end_date) ? results : null;
    }
    return null;
};

/**
 * Los resultados deben estar publicos ya. Sin results_public_at, al terminar la ventana; con el,
 * a esa hora (nunca antes del fin). Un simulacro ya publicado no vuelve a decidirse.
 */
export const resultsDue = (sim, now = new Date()) => {
    if (sim?.public_results === true || !isScheduled(sim)) return false;
    const t = new Date(now).getTime();
    const end = time(sim.end_date);
    const at = time(sim.results_public_at);
    return t >= Math.max(end, at ?? end);
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
