import test, { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedSimulacra } from './helpers/seed.js';
import {
    EXAM_SESSION_TTL_SECONDS, claimExamSession, deviceOf, holderInfo, leaseActive, sessionKey,
} from '../src/modules/simulacra/simulacrum.session.js';

// --- Unitarias: mismas pruebas que eduteka/test/simulacrum/exam_session.test.js (paridad con el monolito) ---

const T0 = new Date('2026-11-10T19:00:00Z');
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);

/**
 * Modelo falso con la semantica de los dos filtros que usa el modulo: coincidencia por id del titular, y
 * "sin titular o titular vencido". Una sola fila, como una inscripcion.
 */
const fakeModel = (row) => {
    const held = (now) => {
        const s = row.exam_session;
        if (!s || s.id == null) return false;
        return new Date(s.last_seen_at).getTime() >= now - EXAM_SESSION_TTL_SECONDS * 1000;
    };
    return {
        row,
        updateOne(filter, update) {
            let matched = false;
            if (row.finished !== true) {
                if (filter['exam_session.id'] !== undefined) {
                    matched = row.exam_session?.id === filter['exam_session.id'];
                    if (matched) row.exam_session.last_seen_at = update.$set['exam_session.last_seen_at'];
                } else if (filter.$or) {
                    const now = new Date(update.$set.exam_session.last_seen_at).getTime();
                    matched = !held(now);
                    if (matched) row.exam_session = update.$set.exam_session;
                }
            }
            return { exec: async () => ({ matchedCount: matched ? 1 : 0 }) };
        },
        findOne() {
            return { lean: () => ({ exec: async () => ({ exam_session: row.exam_session, finished: row.finished }) }) };
        },
    };
};

const web = sessionKey('web', 'aaa');
const app = sessionKey('app', 'bbb');

test('el primer dispositivo reclama; el segundo queda fuera con los datos del titular', async () => {
    const model = fakeModel({ _id: 'e1', finished: false });
    assert.deepEqual(await claimExamSession(model, 'e1', web, 'web', at(0)), { ok: true, took_over: true });

    const blocked = await claimExamSession(model, 'e1', app, 'app', at(10));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.holder.client, 'web');
    assert.equal(blocked.holder.retry_after_seconds, 50); // dio senales en 0: vence en 60, faltan 50
});

test('el titular renueva (recargar, latido, cada respuesta) sin perder el bloqueo', async () => {
    const model = fakeModel({ _id: 'e1', finished: false });
    await claimExamSession(model, 'e1', web, 'web', at(0));
    assert.deepEqual(await claimExamSession(model, 'e1', web, 'web', at(30)), { ok: true, took_over: false });
    // la renovacion empuja el vencimiento: a los 80 s sigue ocupado por el titular
    assert.equal((await claimExamSession(model, 'e1', app, 'app', at(80))).ok, false);
});

test('si el titular deja de dar senales, el otro lo retoma (mismo intento)', async () => {
    const model = fakeModel({ _id: 'e1', finished: false });
    await claimExamSession(model, 'e1', web, 'web', at(0));
    assert.equal((await claimExamSession(model, 'e1', app, 'app', at(59))).ok, false);
    assert.deepEqual(await claimExamSession(model, 'e1', app, 'app', at(61)), { ok: true, took_over: true });
    assert.equal(model.row.exam_session.client, 'app');
    // y el anterior ya no puede escribir
    assert.equal((await claimExamSession(model, 'e1', web, 'web', at(62))).ok, false);
});

test('un intento cerrado no se bloquea: se informa y no hay titular', async () => {
    const model = fakeModel({ _id: 'e1', finished: true });
    const result = await claimExamSession(model, 'e1', web, 'web', at(0));
    assert.equal(result.ok, true);
    assert.equal(result.closed, true);
});

test('dos reclamos simultaneos del mismo dispositivo no se bloquean entre si', async () => {
    // Otro reclamo del mismo dispositivo toma el bloqueo justo despues del paso 1 (renovar) de este.
    const row = { _id: 'e1', finished: false };
    const model = fakeModel(row);
    const original = model.updateOne.bind(model);
    let calls = 0;
    model.updateOne = (filter, update) => {
        const result = original(filter, update);
        calls += 1;
        if (calls === 1) row.exam_session = { id: web, client: 'web', claimed_at: T0, last_seen_at: T0 };
        return result;
    };
    assert.deepEqual(await claimExamSession(model, 'e1', web, 'web', at(1)), { ok: true, took_over: false });
    // Pero otro dispositivo en la misma situacion si queda fuera.
    assert.equal((await claimExamSession(model, 'e1', app, 'app', at(2))).ok, false);
});

test('leaseActive y holderInfo', () => {
    const session = { id: web, client: 'web', last_seen_at: T0 };
    assert.equal(leaseActive(session, at(59)), true);
    assert.equal(leaseActive(session, at(61)), false);
    assert.equal(leaseActive(null, at(0)), false);
    assert.equal(holderInfo(session, at(20)).retry_after_seconds, 40);
    assert.equal(holderInfo(session, at(500)).retry_after_seconds, 1); // nunca 0 ni negativo
    assert.equal(holderInfo({ client: 'app', last_seen_at: T0 }, at(0)).client, 'app');
    assert.equal(sessionKey('web', 'x'), 'web:x');
});

test('deviceOf: client + X-Exam-Session; sin cabecera o invalida => legacy', () => {
    const reqOf = (client, header) => ({ client, get: (name) => (name.toLowerCase() === 'x-exam-session' ? header : undefined) });
    const uuid = '3f1c9a52-8d3e-4b7e-9a51-0c2d6f7e1a44';
    assert.deepEqual(deviceOf(reqOf('web', uuid)), { key: `web:${uuid}`, client: 'web' });
    assert.deepEqual(deviceOf(reqOf('app', uuid)), { key: `app:${uuid}`, client: 'app' });
    assert.deepEqual(deviceOf(reqOf('app', undefined)), { key: 'app:legacy', client: 'app' });
    assert.deepEqual(deviceOf(reqOf('web', undefined)), { key: 'web:legacy', client: 'web' });
    // Cualquier cosa que no parezca un id (muy corto, caracteres raros, demasiado largo) cae a legacy.
    for (const bad of ['x', 'a b c d e f g h', '$set', 'a'.repeat(65), '']) {
        assert.equal(deviceOf(reqOf('app', bad)).key, 'app:legacy', bad);
    }
    // Un client desconocido nunca se cuela en la identidad.
    assert.equal(deviceOf(reqOf(undefined, uuid)).client, 'app');
});

// --- HTTP: dos dispositivos sobre el mismo intento ---

const API = '/api/v1/simulacros';
const SECRET = 'secreto-web-de-prueba-0123456789abcdef';
const person = { fullname: 'Ana Pérez López', dni: '12345678' };
const SID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SID_B = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('un solo dispositivo a la vez en el examen', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ WEB_CLIENT_SECRET: SECRET });
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
    });
    after(() => ctx.stop());

    const enrollments = () => ctx.mongoose.connection.db.collection('usersimulacrums');

    /** Dispositivo: { client: 'app'|'web', sid }. sid undefined => sin cabecera. */
    const device = (client, sid) => ({ client, sid });
    const A = device('app', SID_A);
    const B = device('app', SID_B);

    const call = (method, route, user, dev, body) => {
        const req = request(ctx.app)[method](`${API}${route}`).set(bearer(user));
        if (dev.client === 'web') req.set({ 'X-Edk-Client': 'web', 'X-Edk-Client-Secret': SECRET });
        if (dev.sid) req.set('X-Exam-Session', dev.sid);
        return req.send(body);
    };
    const enrolledUser = async () => {
        const user = await createUser(ctx);
        await request(ctx.app).post(`${API}/simulacro-general/inscribirme`).set(bearer(user)).send(person).expect(201);
        return user;
    };
    const start = (user, dev) => call('post', '/simulacro-general/iniciar', user, dev);
    const rowOf = (user) => enrollments().findOne({ user_id: user.session.user.id, simulacrum_id: 's-simulacro-general' });

    it('A inicia y B no puede: 409 ATTEMPT_ACTIVE_ELSEWHERE con el titular y sin details', async () => {
        const user = await enrolledUser();
        const first = (await start(user, A).expect(200)).body.data;
        assert.deepEqual(first.session, { took_over: true, ttl_seconds: 60, heartbeat_seconds: 20 });

        const res = await start(user, B).expect(409);
        assert.equal(res.body.error.code, 'ATTEMPT_ACTIVE_ELSEWHERE');
        assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'holder', 'message']);
        assert.equal(res.body.error.holder.client, 'app');
        assert.match(res.body.error.holder.last_seen_at, /Z$/);
        const wait = res.body.error.holder.retry_after_seconds;
        assert.ok(wait >= 1 && wait <= 60, `retry_after_seconds=${wait}`);
        assert.ok(res.body.request_id);
    });

    it('B guarda respuestas mientras A es titular: 409 y el mapa de respuestas no cambia', async () => {
        const user = await enrolledUser();
        const { attempt_id: attemptId } = (await start(user, A).expect(200)).body.data;
        await call('put', `/intentos/${attemptId}/respuestas`, user, A, { answers: { a1: 'A' } }).expect(200);

        const res = await call('put', `/intentos/${attemptId}/respuestas`, user, B, { answers: { a1: 'B', a2: 'C' } }).expect(409);
        assert.equal(res.body.error.code, 'ATTEMPT_ACTIVE_ELSEWHERE');
        const { answers } = await rowOf(user);
        assert.deepEqual(Object.keys(answers), ['a1']);
        assert.equal(answers.a1.option, 'A');
    });

    it('latido: el titular 200, el otro 409', async () => {
        const user = await enrolledUser();
        const { attempt_id: attemptId } = (await start(user, A).expect(200)).body.data;

        const ok = (await call('post', `/intentos/${attemptId}/latido`, user, A).expect(200)).body.data;
        assert.equal(ok.ok, true);
        assert.equal(ok.heartbeat_seconds, 20);
        assert.match(ok.server_time, /Z$/);

        const other = await call('post', `/intentos/${attemptId}/latido`, user, B).expect(409);
        assert.equal(other.body.error.code, 'ATTEMPT_ACTIVE_ELSEWHERE');
    });

    it('titular vencido (61 s): B retoma el MISMO intento, con el mismo cronometro y respuestas; A queda fuera', async () => {
        const user = await enrolledUser();
        const first = (await start(user, A).expect(200)).body.data;
        await call('put', `/intentos/${first.attempt_id}/respuestas`, user, A, { answers: { a1: 'A' } }).expect(200);
        await enrollments().updateOne({ _id: first.attempt_id }, { $set: { 'exam_session.last_seen_at': new Date(Date.now() - 61_000) } });

        const taken = (await start(user, B).expect(200)).body.data;
        assert.equal(taken.attempt_id, first.attempt_id);
        assert.equal(taken.end_exam, first.end_exam);
        assert.equal(taken.start_exam, first.start_exam);
        assert.equal(taken.answers.a1, 'A');
        assert.equal(taken.session.took_over, true);

        await call('put', `/intentos/${first.attempt_id}/respuestas`, user, A, { answers: { a2: 'B' } }).expect(409);
        await call('post', `/intentos/${first.attempt_id}/latido`, user, A).expect(409);
    });

    it('el mismo dispositivo reabre de inmediato, sin tomarlo de nadie', async () => {
        const user = await enrolledUser();
        await start(user, A).expect(200);
        const again = (await start(user, A).expect(200)).body.data;
        assert.equal(again.session.took_over, false);
    });

    it('la identidad incluye el cliente: web con sid=x y app con sid=x se bloquean', async () => {
        const user = await enrolledUser();
        await start(user, device('web', SID_A)).expect(200);
        const res = await start(user, device('app', SID_A)).expect(409);
        assert.equal(res.body.error.code, 'ATTEMPT_ACTIVE_ELSEWHERE');
        assert.equal(res.body.error.holder.client, 'web');
    });

    it('sin cabecera X-Exam-Session: sid legacy; web y app siguen bloqueandose, y el mismo cliente entra', async () => {
        const user = await enrolledUser();
        await start(user, device('app', undefined)).expect(200);
        await start(user, device('web', undefined)).expect(409);
        await start(user, device('app', undefined)).expect(200);
        // Un sid con forma invalida cae a legacy.
        await start(user, device('app', '$set')).expect(200);
    });

    it('dos iniciar simultaneos de dos dispositivos: exactamente uno 200 y otro 409', async () => {
        const user = await enrolledUser();
        const results = await Promise.all([start(user, A), start(user, B)]);
        const statuses = results.map((res) => res.status).sort();
        assert.deepEqual(statuses, [200, 409]);
        assert.equal(results.find((res) => res.status === 409).body.error.code, 'ATTEMPT_ACTIVE_ELSEWHERE');
        const row = await rowOf(user);
        assert.ok(row.start_exam && row.end_exam);
    });

    it('finalizar: un no titular 409, el titular 200', async () => {
        const user = await enrolledUser();
        const { attempt_id: attemptId } = (await start(user, A).expect(200)).body.data;
        const denied = await call('post', `/intentos/${attemptId}/finalizar`, user, B, {}).expect(409);
        assert.equal(denied.body.error.code, 'ATTEMPT_ACTIVE_ELSEWHERE');
        assert.equal((await rowOf(user)).finished, false);
        await call('post', `/intentos/${attemptId}/finalizar`, user, A, {}).expect(200);
    });

    it('latido con el intento ya cerrado: 409 ATTEMPT_ALREADY_FINISHED', async () => {
        const user = await enrolledUser();
        const { attempt_id: attemptId } = (await start(user, A).expect(200)).body.data;
        await call('post', `/intentos/${attemptId}/finalizar`, user, A, {}).expect(200);
        const res = await call('post', `/intentos/${attemptId}/latido`, user, A).expect(409);
        assert.equal(res.body.error.code, 'ATTEMPT_ALREADY_FINISHED');
    });

    it('reintentar deja el bloqueo limpio en el intento nuevo', async () => {
        const user = await enrolledUser();
        const { attempt_id: attemptId } = (await start(user, A).expect(200)).body.data;
        await call('post', `/intentos/${attemptId}/finalizar`, user, A, {}).expect(200);
        assert.ok((await rowOf(user)).exam_session, 'el intento 1 conserva su bloqueo');

        await call('post', '/simulacro-general/reintentar', user, A, {}).expect(201);
        const row = await rowOf(user);
        assert.equal(row.attempt_number, 2);
        assert.equal(row.exam_session, undefined);
        // Otro dispositivo puede abrir el reintento: nadie lo tiene.
        await start(user, B).expect(200);
    });

    it('ficha, resultados y solucionario no pasan por el bloqueo', async () => {
        const user = await enrolledUser();
        await start(user, A).expect(200);
        await call('get', '/simulacro-general', user, B).expect(200);
        await call('get', '/simulacro-general/resultados', user, B).expect(200);
    });
});
