import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PHASES, attemptDeadline, canRegister, canStart, getPhase, isScheduled, milestoneAt, nextEvent, resultsAt,
    resultsDue, resultsPublished, scheduleView, upcomingEvents,
} from '../src/modules/simulacra/simulacrum.window.js';
import { ApiError } from '../src/libs/api_error.js';
import { errorBody } from '../src/libs/envelope.js';

// Mismas tablas de verdad que eduteka/test/simulacrum/window.test.js (paridad con el monolito).
const sim = {
    register_close_date: new Date('2026-11-10T18:00:00Z'),
    start_date: new Date('2026-11-10T19:00:00Z'),
    end_date: new Date('2026-11-10T21:00:00Z'),
    for_register: true,
};
const at = (iso) => new Date(iso);

test('fases en los bordes de la ventana', () => {
    assert.equal(getPhase(sim, at('2026-11-10T17:59:59Z')), PHASES.REGISTRATION);
    assert.equal(getPhase(sim, at('2026-11-10T18:00:00Z')), PHASES.WAITING);
    assert.equal(getPhase(sim, at('2026-11-10T18:59:59Z')), PHASES.WAITING);
    assert.equal(getPhase(sim, at('2026-11-10T19:00:00Z')), PHASES.LIVE);
    assert.equal(getPhase(sim, at('2026-11-10T20:59:59Z')), PHASES.LIVE);
    assert.equal(getPhase(sim, at('2026-11-10T21:00:00Z')), PHASES.FINISHED);
});

test('finished manda sobre las fechas; for_register=false deja la espera', () => {
    assert.equal(getPhase({ ...sim, finished: true }, at('2026-11-10T10:00:00Z')), PHASES.FINISHED);
    assert.equal(getPhase({ ...sim, for_register: false }, at('2026-11-10T10:00:00Z')), PHASES.WAITING);
    assert.equal(getPhase({}, new Date()), PHASES.LIVE);
});

test('isScheduled exige las dos fechas validas', () => {
    assert.equal(isScheduled(sim), true);
    assert.equal(isScheduled({ start_date: sim.start_date }), false);
    assert.equal(isScheduled({ start_date: 'x', end_date: sim.end_date }), false);
    assert.equal(isScheduled(null), false);
});

test('inscripcion: solo antes del cierre y con for_register', () => {
    assert.equal(canRegister(sim, at('2026-11-10T17:00:00Z')), true);
    assert.equal(canRegister(sim, at('2026-11-10T18:00:00Z')), false);
    assert.equal(canRegister({ ...sim, for_register: false }, at('2026-11-10T10:00:00Z')), false);
    assert.equal(canRegister({ ...sim, finished: true }, at('2026-11-10T10:00:00Z')), false);
    // Sin el campo definido se permite (el esquema tiene default true).
    assert.equal(canRegister({ ...sim, for_register: undefined }, at('2026-11-10T10:00:00Z')), true);
    // Cierre posterior al inicio: durante live nadie se inscribe.
    const late = { ...sim, register_close_date: new Date('2026-11-10T20:00:00Z') };
    assert.equal(canRegister(late, at('2026-11-10T19:30:00Z')), false);
});

test('sin cierre explicito, la inscripcion cierra al inicio', () => {
    const s = { ...sim, register_close_date: null };
    assert.equal(canRegister(s, at('2026-11-10T18:59:00Z')), true);
    assert.equal(canRegister(s, at('2026-11-10T19:00:00Z')), false);
});

test('canStart solo en live; sin programar siempre salvo cerrado', () => {
    assert.equal(canStart(sim, at('2026-11-10T18:30:00Z')), false);
    assert.equal(canStart(sim, at('2026-11-10T19:00:00Z')), true);
    assert.equal(canStart({ finished: false }, new Date()), true);
    assert.equal(canStart({ finished: true }, new Date()), false);
});

test('el intento no pasa de end_date', () => {
    assert.equal(attemptDeadline(sim, at('2026-11-10T20:30:00Z'), 120).toISOString(), '2026-11-10T21:00:00.000Z');
    assert.equal(attemptDeadline(sim, at('2026-11-10T19:00:00Z'), 60).toISOString(), '2026-11-10T20:00:00.000Z');
    // Sin programar no hay tope.
    assert.equal(attemptDeadline({}, at('2026-11-10T20:30:00Z'), 120).toISOString(), '2026-11-10T22:30:00.000Z');
});

test('entrar tarde acorta el intento (ventana 5 min, duracion 3)', () => {
    const w = { start_date: at('2026-11-10T19:00:00Z'), end_date: at('2026-11-10T19:05:00Z') };
    const left = (open) => (attemptDeadline(w, at(open), 3) - at(open)) / 60000;
    assert.equal(left('2026-11-10T19:02:00Z'), 3);
    assert.equal(left('2026-11-10T19:03:00Z'), 2);
    assert.equal(left('2026-11-10T19:04:00Z'), 1);
});

test('resultsAt y resultsPublished', () => {
    assert.equal(resultsAt(sim), sim.end_date);
    const s = { ...sim, results_public_at: new Date('2026-11-10T22:00:00Z') };
    assert.equal(resultsAt(s), s.results_public_at);

    // Programado: solo === true. Resto: regla historica.
    assert.equal(resultsPublished(sim), false);
    assert.equal(resultsPublished({ ...sim, public_results: false }), false);
    assert.equal(resultsPublished({ ...sim, public_results: true }), true);
    assert.equal(resultsPublished({}), true);
    assert.equal(resultsPublished({ public_results: false }), false);
});

test('scheduleView sirve fechas ISO; null si no esta programado', () => {
    const v = scheduleView({ ...sim, results_public_at: new Date('2026-11-10T22:00:00Z') }, at('2026-11-10T10:00:00Z'));
    assert.deepEqual(v, {
        phase: 'registration',
        registration_open: true,
        register_close_date: '2026-11-10T18:00:00.000Z',
        start_date: '2026-11-10T19:00:00.000Z',
        end_date: '2026-11-10T21:00:00.000Z',
        results_at: '2026-11-10T22:00:00.000Z',
        results_published: false,
    });
    assert.equal(scheduleView({}, new Date()), null);
    // Sin cierre explicito, `register_close_date` sale como el inicio; sin results_public_at, el fin.
    const bare = scheduleView({ ...sim, register_close_date: null }, at('2026-11-10T20:00:00Z'));
    assert.equal(bare.register_close_date, '2026-11-10T19:00:00.000Z');
    assert.equal(bare.results_at, '2026-11-10T21:00:00.000Z');
    assert.equal(bare.phase, 'live');
    assert.equal(bare.registration_open, false);
});

test('errores nuevos: codigo y estado HTTP', () => {
    const cases = [
        [ApiError.registrationClosed(), 403, 'REGISTRATION_CLOSED'],
        [ApiError.notStarted(), 403, 'NOT_STARTED'],
        [ApiError.windowEnded(), 403, 'WINDOW_ENDED'],
        [ApiError.attemptFinished(), 409, 'ATTEMPT_ALREADY_FINISHED'],
        [ApiError.attemptActiveElsewhere({ client: 'web' }), 409, 'ATTEMPT_ACTIVE_ELSEWHERE'],
    ];
    for (const [error, status, code] of cases) {
        assert.equal(error.status, status);
        assert.equal(error.code, code);
    }
});

test('errorBody: holder al nivel de code/message, sin details, y extra no pisa code', () => {
    const holder = { client: 'app', last_seen_at: '2026-11-10T19:00:12.000Z', retry_after_seconds: 48 };
    const body = errorBody({ id: 'req-1' }, ApiError.attemptActiveElsewhere(holder));
    assert.deepEqual(body, {
        error: { holder, code: 'ATTEMPT_ACTIVE_ELSEWHERE', message: 'Tu examen está abierto en otro dispositivo.' },
        request_id: 'req-1',
    });
    assert.equal('details' in body.error, false);

    const evil = new ApiError(409, 'X', 'm', { extra: { code: 'HACK', message: 'hack' } });
    const { error } = errorBody({ id: 'r' }, evil);
    assert.equal(error.code, 'X');
    assert.equal(error.message, 'm');

    // Un error sin extra conserva la forma de siempre.
    assert.deepEqual(errorBody({ id: 'r' }, ApiError.notFound()).error, { code: 'NOT_FOUND', message: 'No se encontró el recurso solicitado.' });
});

// --- Hitos del planificador (paridad con nextEvent/resultsDue del monolito) ---

test('nextEvent: cierre, inicio, fin y resultados programados', () => {
    const s = { ...sim, results_public_at: new Date('2026-11-10T22:00:00Z') };
    assert.equal(nextEvent(s, at('2026-11-10T10:00:00Z')).kind, 'close');
    assert.equal(nextEvent(s, at('2026-11-10T18:30:00Z')).kind, 'start');
    assert.equal(nextEvent(s, at('2026-11-10T19:30:00Z')).kind, 'end');
    assert.equal(nextEvent(s, at('2026-11-10T21:30:00Z')).kind, 'results');
    assert.equal(nextEvent(s, at('2026-11-10T22:00:00Z')), null);
});

test('nextEvent: sin results_public_at no hay hito de resultados; publico o cerrado a mano lo omiten', () => {
    assert.equal(nextEvent(sim, at('2026-11-10T21:30:00Z')), null);
    const s = { ...sim, results_public_at: new Date('2026-11-10T22:00:00Z') };
    assert.equal(nextEvent({ ...s, public_results: true }, at('2026-11-10T21:30:00Z')), null);
    // Cerrado a mano antes del fin: no vigila inicio/fin, pero los resultados siguen pendientes.
    assert.equal(nextEvent({ ...s, finished: true }, at('2026-11-10T19:30:00Z')).kind, 'results');
});

test('resultsDue: al terminar la ventana o a la hora programada, nunca antes', () => {
    assert.equal(resultsDue(sim, at('2026-11-10T20:59:59Z')), false);
    assert.equal(resultsDue(sim, at('2026-11-10T21:00:00Z')), true);
    const s = { ...sim, results_public_at: new Date('2026-11-10T22:00:00Z') };
    assert.equal(resultsDue(s, at('2026-11-10T21:30:00Z')), false);
    assert.equal(resultsDue(s, at('2026-11-10T22:00:00Z')), true);
    assert.equal(resultsDue({ ...sim, public_results: true }, at('2026-11-10T23:00:00Z')), false);
    assert.equal(resultsDue({ finished: false }, new Date()), false);
});

test('upcomingEvents: todos los hitos futuros en orden, y ninguno sin programar', () => {
    const s = { ...sim, results_public_at: new Date('2026-11-10T22:00:00Z') };
    assert.deepEqual(upcomingEvents(s, at('2026-11-10T10:00:00Z')).map((e) => e.kind), ['close', 'start', 'end', 'results']);
    assert.deepEqual(upcomingEvents(s, at('2026-11-10T19:30:00Z')).map((e) => e.kind), ['end', 'results']);
    assert.deepEqual(upcomingEvents(s, at('2026-11-10T22:00:00Z')), []);
    assert.deepEqual(upcomingEvents({}, new Date()), []);
    // Sin cierre propio (cierra al iniciar) no hay hito `close`.
    const noClose = { start_date: sim.start_date, end_date: sim.end_date };
    assert.deepEqual(upcomingEvents(noClose, at('2026-11-10T10:00:00Z')).map((e) => e.kind), ['start', 'end']);
});

test('milestoneAt: instante vigente de cada hito; null si ya no existe', () => {
    const s = { ...sim, results_public_at: new Date('2026-11-10T22:00:00Z') };
    assert.equal(milestoneAt(s, 'close'), Date.parse('2026-11-10T18:00:00Z'));
    assert.equal(milestoneAt(s, 'start'), Date.parse('2026-11-10T19:00:00Z'));
    assert.equal(milestoneAt(s, 'end'), Date.parse('2026-11-10T21:00:00Z'));
    assert.equal(milestoneAt(s, 'results'), Date.parse('2026-11-10T22:00:00Z'));
    assert.equal(milestoneAt(sim, 'results'), null);
    assert.equal(milestoneAt({ start_date: sim.start_date, end_date: sim.end_date }, 'close'), null);
    assert.equal(milestoneAt({}, 'start'), null);
    assert.equal(milestoneAt(s, 'otro'), null);
});
