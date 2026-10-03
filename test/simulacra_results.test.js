import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedSimulacra } from './helpers/seed.js';

const API = '/api/v1/simulacros';

describe('simulacros: resultados, ranking, reintentos y solucionario', () => {
    let ctx;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const api = (method, route, user, body) => request(ctx.app)[method](`${API}${route}`).set(user ? bearer(user) : {}).send(body);
    const get = (route, user) => request(ctx.app).get(`${API}${route}`).set(user ? bearer(user) : {});

    const enroll = async (slug, fullname = 'Ana Pérez López', overrides = {}) => {
        const user = await createUser(ctx, overrides);
        await api('post', `/${slug}/inscribirme`, user, { fullname, dni: '12345678' }).expect(201);
        return user;
    };
    /** Inscribe, rinde y finaliza. Devuelve { user, attemptId, summary }. */
    const take = async (slug, answers, fullname) => {
        const user = await enroll(slug, fullname);
        const started = (await api('post', `/${slug}/iniciar`, user).expect(200)).body.data;
        if (Object.keys(answers).length) await api('put', `/intentos/${started.attempt_id}/respuestas`, user, { answers }).expect(200);
        const summary = (await api('post', `/intentos/${started.attempt_id}/finalizar`, user, {}).expect(200)).body.data;
        return { user, attemptId: started.attempt_id, summary };
    };
    const finishAfterRetry = async (slug, user, answers) => {
        const started = (await api('post', `/${slug}/iniciar`, user).expect(200)).body.data;
        if (Object.keys(answers).length) await api('put', `/intentos/${started.attempt_id}/respuestas`, user, { answers }).expect(200);
        return (await api('post', `/intentos/${started.attempt_id}/finalizar`, user, {}).expect(200)).body.data;
    };

    describe('GET /simulacros/:slug/resultados', () => {
        it('exige sesion; un simulacro inexistente o oculto es 404', async () => {
            await get('/simulacro-general/resultados').expect(401);
            const user = await createUser(ctx);
            await get('/no-existe/resultados', user).expect(404);
            await get('/oculto/resultados', user).expect(404);
        });

        it('quien no esta inscrito ve solo el ranking publico', async () => {
            const stranger = await createUser(ctx);
            const res = await get('/simulacro-general/resultados', stranger).expect(200);

            assert.equal(res.body.data.enrolled, false);
            assert.equal(res.body.data.attempt, null);
            assert.deepEqual(res.body.data.attempts, []);
            assert.equal(res.body.data.ranking.visible, true);
            assert.equal(res.body.data.ranking.me, null);
            assert.equal(res.body.data.retry_blocked_reason, null);
        });

        it('un simulacro con resultados privados es 404 para quien no participo', async () => {
            const stranger = await createUser(ctx);
            await get('/privado/resultados', stranger).expect(404);
        });

        it('inscrito pero sin terminar: sin resultado propio', async () => {
            const user = await enroll('simulacro-general');
            await api('post', '/simulacro-general/iniciar', user).expect(200);
            const res = await get('/simulacro-general/resultados', user).expect(200);

            assert.equal(res.body.data.enrolled, true);
            assert.equal(res.body.data.attempt, null);
            assert.deepEqual(res.body.data.by_area, []);
            assert.equal(res.body.data.can_retry, false);
            assert.equal(res.body.data.retry_blocked_reason, 'Todavía tienes un intento en curso');
        });

        it('terminado: resumen, desglose por area e historial con el intento oficial', async () => {
            const { user, attemptId } = await take('simulacro-general', { a1: 'A', a2: 'C' });
            const { data } = (await get('/simulacro-general/resultados', user).expect(200)).body;

            assert.equal(data.attempt.attempt_id, attemptId);
            assert.deepEqual([data.attempt.correct, data.attempt.incorrect, data.attempt.not_answered, data.attempt.total, data.attempt.score], [1, 1, 1, 3, 3]);
            assert.deepEqual(data.by_area.map((area) => [area.area, area.total, area.correct, area.score]).sort(), [['Lenguaje', 1, 0, 0], ['Matemática', 2, 1, 3]]);
            assert.equal(data.attempts.length, 1);
            assert.deepEqual([data.attempts[0].attempt_number, data.attempts[0].is_current, data.attempts[0].is_official], [1, true, true]);
            assert.equal(data.can_retry, true);
            assert.equal(data.retry_blocked_reason, null);
        });

        it('ranking: posicion con empates (1, 2, 2, 4) y percentil de cada participante', async () => {
            // Un simulacro limpio: en el general ya hay participantes de otras pruebas.
            const source = await db('simulacrums').findOne({ slug: 'simulacro-general' });
            await db('simulacrums').insertOne({ ...source, _id: 's-ranking', slug: 'ranking', title: 'Ranking' });

            const first = await take('ranking', { a1: 'A', a2: 'B', l1: 'C' }, 'Primero Perfecto'); // 12
            const second = await take('ranking', { a1: 'A' }, 'Segundo Empate'); // 4
            const tied = await take('ranking', { a1: 'A' }, 'Tercero Empate'); // 4
            const last = await take('ranking', { a1: 'B', a2: 'A' }, 'Ultimo Lugar'); // -2

            const mine = async (who) => (await get('/ranking/resultados', who.user).expect(200)).body.data.ranking;
            const r1 = await mine(first);
            assert.equal(r1.visible, true);
            assert.equal(r1.total_participants, 4);
            assert.deepEqual([r1.me.rank, r1.me.percentile], [1, 75]);
            assert.deepEqual(r1.top.map((row) => [row.rank, row.fullname]), [
                [1, 'Primero Perfecto'], [2, r1.top[1].fullname], [2, r1.top[2].fullname], [4, 'Ultimo Lugar'],
            ]);
            assert.deepEqual([r1.top[1].fullname, r1.top[2].fullname].sort(), ['Segundo Empate', 'Tercero Empate']);

            const [r2, r3, r4] = [await mine(second), await mine(tied), await mine(last)];
            assert.deepEqual([r2.me.rank, r2.me.percentile], [2, 25]);
            assert.deepEqual([r3.me.rank, r3.me.percentile], [2, 25]);
            assert.deepEqual([r4.me.rank, r4.me.percentile], [4, 0]);
            assert.equal(r2.top.filter((row) => row.is_me).length, 1);
        });

        it('el ranking no expone datos personales de contacto (solo nombre, area y carrera)', async () => {
            const { user } = await take('simulacro-general', { a1: 'A' }, 'Nombre Visible');
            const res = await get('/simulacro-general/resultados', user).expect(200);
            const json = JSON.stringify(res.body.data.ranking);
            assert.ok(!json.includes('12345678'), 'expone el DNI');
            assert.ok(!json.includes('@'), 'expone un correo');
            assert.ok(!json.includes('user_id'));
            assert.deepEqual(Object.keys(res.body.data.ranking.top[0]).sort(), ['area', 'career', 'fullname', 'is_me', 'rank', 'score', 'score_conversion']);
        });

        it('resultados privados: el participante ve lo suyo, pero la tabla se publica al cerrar el simulacro', async () => {
            const { user } = await take('privado', { a1: 'A' });
            const stranger = await createUser(ctx);

            const open = (await get('/privado/resultados', user).expect(200)).body.data;
            assert.equal(open.attempt.correct, 1);
            assert.deepEqual(open.ranking, { visible: false });

            await db('simulacrums').updateOne({ slug: 'privado' }, { $set: { finished: true } });
            const closed = (await get('/privado/resultados', user).expect(200)).body.data;
            assert.equal(closed.ranking.visible, true);
            assert.equal(closed.ranking.me.rank, 1);
            // Quien no participo sigue sin verla.
            await get('/privado/resultados', stranger).expect(404);
        });

        it('califica al consultar si se acabo el tiempo y nadie cerro el intento', async () => {
            const user = await enroll('simulacro-general');
            const { attempt_id: attemptId } = (await api('post', '/simulacro-general/iniciar', user).expect(200)).body.data;
            await api('put', `/intentos/${attemptId}/respuestas`, user, { answers: { a1: 'A', a2: 'B' } }).expect(200);
            await db('usersimulacrums').updateOne({ _id: attemptId }, { $set: { end_exam: new Date(Date.now() - 60_000) } });

            const { data } = (await get('/simulacro-general/resultados', user).expect(200)).body;
            assert.deepEqual([data.attempt.correct, data.attempt.not_answered, data.attempt.score], [2, 1, 8]);
            assert.equal((await db('usersimulacrums').findOne({ _id: attemptId })).finished, true);
        });

        it('un reintento recien abierto NO se cierra con cero al consultar los resultados', async () => {
            const { user, attemptId } = await take('simulacro-general', { a1: 'A', a2: 'B', l1: 'C' });
            await api('post', '/simulacro-general/reintentar', user).expect(201);
            const res = await get('/simulacro-general/resultados', user).expect(200);

            const row = await db('usersimulacrums').findOne({ _id: attemptId });
            assert.equal(row.finished, false);
            assert.equal(row.attempt_number, 2);
            assert.equal(row.score, 12); // el puntaje del intento anterior se conserva hasta que termine el nuevo
            assert.equal(res.body.data.attempt, null);
        });

        it('completa el puntaje de una fila heredada (terminada, de antes de guardar la nota)', async () => {
            const user = await createUser(ctx);
            const id = `legacy-${user.session.user.id}`;
            await db('usersimulacrums').insertOne({
                _id: id, user_id: user.session.user.id, simulacrum_id: 's-simulacro-general', area: 'I', state: true, finished: true,
                answers: { a1: { option: 'A' }, l1: { option: 'C' } }, start_exam: new Date(Date.now() - 7_200_000),
                end_exam: new Date(Date.now() - 3_600_000), exam_finished: new Date(Date.now() - 3_600_000),
            });

            const { data } = (await get('/simulacro-general/resultados', user).expect(200)).body;
            assert.deepEqual([data.attempt.correct, data.attempt.not_answered, data.attempt.score], [2, 1, 8]);
            const row = await db('usersimulacrums').findOne({ _id: id });
            assert.equal(row.score, 8);
            assert.equal(row.official_score, 8);
            assert.equal(await db('simulacrumattempts').countDocuments({ user_simulacrum_id: id }), 1);
        });

        it('los docentes pueden ver los resultados publicos', async () => {
            const teacher = await createUser(ctx, { account_type: 'Profesor' });
            const res = await get('/simulacro-general/resultados', teacher).expect(200);
            assert.equal(res.body.data.enrolled, false);
        });
    });

    describe('POST /simulacros/:slug/reintentar', () => {
        it('exige sesion, estudiante e inscripcion', async () => {
            await api('post', '/simulacro-general/reintentar', null).expect(401);
            const teacher = await createUser(ctx, { account_type: 'Profesor' });
            await api('post', '/simulacro-general/reintentar', teacher).expect(403);
            const stranger = await createUser(ctx);
            await api('post', '/simulacro-general/reintentar', stranger).expect(404);
        });

        it('con un intento en curso -> 409', async () => {
            const user = await enroll('simulacro-general');
            const res = await api('post', '/simulacro-general/reintentar', user).expect(409);
            assert.match(res.body.error.message, /en curso/);
            await api('post', '/simulacro-general/iniciar', user).expect(200);
            await api('post', '/simulacro-general/reintentar', user).expect(409);
        });

        it('archiva el intento, abre el siguiente con cronometro nuevo y las respuestas vacias', async () => {
            const { user, attemptId } = await take('simulacro-general', { a1: 'A', a2: 'B' });
            const before = await db('usersimulacrums').findOne({ _id: attemptId });

            const res = await api('post', '/simulacro-general/reintentar', user).expect(201);
            assert.deepEqual(res.body.data, { attempt_id: attemptId, attempt_number: 2 });

            const started = (await api('post', '/simulacro-general/iniciar', user).expect(200)).body.data;
            assert.equal(started.attempt_number, 2);
            assert.deepEqual(started.answers, {});
            assert.ok(new Date(started.start_exam) > before.start_exam);

            const archived = await db('simulacrumattempts').find({ user_simulacrum_id: attemptId }).toArray();
            assert.deepEqual(archived.map((row) => row.attempt_number), [1]);
            assert.equal(archived[0].score, 8);
        });

        it('el ranking publico conserva el PRIMER puntaje aunque el reintento sea mejor; el postulante ve el ultimo', async () => {
            const { user, attemptId } = await take('simulacro-general', { a1: 'A' }); // 4
            await api('post', '/simulacro-general/reintentar', user).expect(201);
            const second = await finishAfterRetry('simulacro-general', user, { a1: 'A', a2: 'B', l1: 'C' }); // 12
            assert.equal(second.score, 12);
            assert.equal(second.attempt_number, 2);

            const stored = await db('usersimulacrums').findOne({ _id: attemptId });
            assert.equal(stored.score, 12);
            assert.equal(stored.official_score, 4);

            const { data } = (await get('/simulacro-general/resultados', user).expect(200)).body;
            assert.equal(data.attempt.score, 12);
            assert.equal(data.ranking.me.score, 4);
            assert.equal(data.ranking.has_retries, true);
            assert.deepEqual(data.attempts.map((attempt) => [attempt.attempt_number, attempt.score, attempt.is_current, attempt.is_official]), [
                [2, 12, true, false],
                [1, 4, false, true],
            ]);
            assert.equal(await db('simulacrumattempts').countDocuments({ user_simulacrum_id: attemptId }), 2);
        });

        it('mientras se rinde el reintento, el historial conserva el anterior y el solucionario se cierra', async () => {
            const { user } = await take('simulacro-general', { a1: 'A' });
            await api('post', '/simulacro-general/reintentar', user).expect(201);
            await api('post', '/simulacro-general/iniciar', user).expect(200);

            const { data } = (await get('/simulacro-general/resultados', user).expect(200)).body;
            assert.equal(data.attempt, null);
            assert.deepEqual(data.attempts.map((attempt) => [attempt.attempt_number, attempt.is_current]), [[1, false]]);
            await get('/simulacro-general/solucionario', user).expect(403);
        });

        it('dos reintentos simultaneos solo suman un intento', async () => {
            const { user, attemptId } = await take('simulacro-general', { a1: 'A' });
            const results = await Promise.all([
                api('post', '/simulacro-general/reintentar', user),
                api('post', '/simulacro-general/reintentar', user),
            ]);
            assert.ok(results.every((res) => [201, 409].includes(res.status)), results.map((res) => res.status).join());
            assert.ok(results.some((res) => res.status === 201));
            assert.equal((await db('usersimulacrums').findOne({ _id: attemptId })).attempt_number, 2);
            assert.equal(await db('simulacrumattempts').countDocuments({ user_simulacrum_id: attemptId }), 1);
        });

        it('un simulacro cerrado por el administrador admite reintentos (practica) y se puede rendir', async () => {
            const user = await createUser(ctx);
            const id = `closed-${user.session.user.id}`;
            await db('usersimulacrums').insertOne({
                _id: id, user_id: user.session.user.id, simulacrum_id: 's-cerrado-admin', area: 'I', state: true, finished: true,
                attempt_number: 1, answers: { a1: { option: 'A' } }, score: 4, questions_correct: 1, questions_incorrect: 0, questions_not_answered: 2,
                exam_finished: new Date(Date.now() - 3_600_000),
            });

            await api('post', '/cerrado-admin/reintentar', user).expect(201);
            const started = (await api('post', '/cerrado-admin/iniciar', user).expect(200)).body.data;
            assert.equal(started.attempt_number, 2);
            await api('put', `/intentos/${id}/respuestas`, user, { answers: { a1: 'A' } }).expect(200);
            const done = (await api('post', `/intentos/${id}/finalizar`, user, {}).expect(200)).body.data;
            assert.equal(done.attempt_number, 2);
            // El primer intento (4) sigue siendo el oficial.
            assert.equal((await db('usersimulacrums').findOne({ _id: id })).official_score, 4);
        });

        it('si el simulacro deja de estar publicado, no se puede reintentar (409)', async () => {
            const user = await createUser(ctx);
            await db('usersimulacrums').insertOne({
                _id: `hidden-${user.session.user.id}`, user_id: user.session.user.id, simulacrum_id: 's-oculto', area: 'I',
                state: true, finished: true, attempt_number: 1, score: 1,
            });
            const res = await api('post', '/oculto/reintentar', user).expect(409);
            assert.match(res.body.error.message, /ya no está disponible/);
        });
    });

    describe('eventos con ventana global', () => {
        it('flujo completo dentro de la ventana: inscribirse, rendir, finalizar y ver el ranking', async () => {
            const { user, summary } = await take('evento-vivo', { a1: 'A', a2: 'B', l1: 'C' });
            assert.equal(summary.score, 12);
            const res = await get('/evento-vivo/resultados', user).expect(200);
            assert.equal(res.body.data.simulacrum.status, 'live');
            assert.equal(res.body.data.ranking.me.rank, 1);
        });
    });

    describe('GET /simulacros/:slug/solucionario', () => {
        it('exige sesion; sin inscripcion, 404', async () => {
            await get('/simulacro-general/solucionario').expect(401);
            const stranger = await createUser(ctx);
            await get('/simulacro-general/solucionario', stranger).expect(404);
        });

        it('no se habilita hasta terminar el intento (403)', async () => {
            const user = await enroll('simulacro-general');
            await api('post', '/simulacro-general/iniciar', user).expect(200);
            const res = await get('/simulacro-general/solucionario', user).expect(403);
            assert.match(res.body.error.message, /termines tu intento/);
        });

        it('devuelve cada pregunta con su clave, explicacion, lo que marco y si acerto', async () => {
            const { user } = await take('simulacro-general', { a1: 'A', a2: 'C' });
            const { data } = (await get('/simulacro-general/solucionario', user).expect(200)).body;

            assert.deepEqual(data.items.map((item) => [item.kind, item.id, item.n]), [
                ['reading', 'r1', undefined], ['question', 'a1', 1], ['question', 'a2', 2], ['question', 'l1', 3],
            ]);
            const [, a1, a2, l1] = data.items;
            assert.deepEqual([a1.correct, a1.selected, a1.is_correct], ['A', 'A', true]);
            assert.deepEqual([a2.correct, a2.selected, a2.is_correct], ['B', 'C', false]);
            assert.deepEqual([l1.correct, l1.selected, l1.is_correct], ['C', null, false]);
            assert.match(a1.explanation, /Explicación a1/);
            assert.match(a1.question, /src="https:\/\/eduteka\.test\/images\/questions\/a1\.png"/);
            assert.deepEqual(a1.options.map((option) => option.key), ['A', 'B', 'C', 'D']);
        });

        it('cada postulante ve sus propias respuestas', async () => {
            const one = await take('simulacro-general', { a1: 'A' });
            const two = await take('simulacro-general', { a1: 'D' });
            const first = (await get('/simulacro-general/solucionario', one.user).expect(200)).body.data.items[1];
            const second = (await get('/simulacro-general/solucionario', two.user).expect(200)).body.data.items[1];
            assert.equal(first.selected, 'A');
            assert.equal(second.selected, 'D');
        });

        it('en un evento en curso no se abre aunque ya hayas terminado (no pasar las respuestas a los demas)', async () => {
            const { user } = await take('evento-vivo', { a1: 'A' });
            const res = await get('/evento-vivo/solucionario', user).expect(403);
            assert.match(res.body.error.message, /cierre el simulacro/);

            await db('simulacrums').updateOne({ slug: 'evento-vivo' }, { $set: { end_date: new Date(Date.now() - 1000) } });
            await get('/evento-vivo/solucionario', user).expect(200);
            await db('simulacrums').updateOne({ slug: 'evento-vivo' }, { $set: { end_date: new Date(Date.now() + 3_600_000) } });
        });

        it('docentes: sin suscripcion 403; con suscripcion pueden revisar un area; administradores siempre', async () => {
            const teacher = await createUser(ctx, { account_type: 'Profesor' });
            const refused = await get('/simulacro-areas/solucionario', teacher).expect(403);
            assert.equal(refused.body.error.code, 'SUBSCRIPTION_REQUIRED');

            await ctx.User.updateOne({ _id: teacher.session.user.id }, { $set: { suscription: { status: 'activo', end_date: new Date(Date.now() + 86_400_000) } } });
            const areaB = (await get('/simulacro-areas/solucionario?area=B', teacher).expect(200)).body.data;
            assert.equal(areaB.area, 'B');
            assert.deepEqual(areaB.items.map((item) => item.id), ['b3']);
            assert.equal(areaB.items[0].selected, null);
            // Un area inexistente cae a la primera.
            assert.equal((await get('/simulacro-areas/solucionario?area=Z', teacher).expect(200)).body.data.area, 'A');

            const admin = await createUser(ctx);
            await ctx.User.updateOne({ _id: admin.session.user.id }, { $set: { rol: 'Administrador' } });
            await get('/simulacro-areas/solucionario', admin).expect(200);
        });
    });

    describe('simulacro de prospecto (puntaje con conversion y preguntas por referencia)', () => {
        it('completa las preguntas y la lectura desde el banco, y puntua con la formula del prospecto', async () => {
            const user = await enroll('simulacro-prospecto');
            const started = (await api('post', '/simulacro-prospecto/iniciar', user).expect(200)).body.data;

            assert.deepEqual(started.items.map((item) => [item.kind, item.id]), [['question', 'pq1'], ['question', 'pq2'], ['reading', 'pb1']]);
            assert.match(started.items[0].question, /PQ1/);
            assert.match(started.items[2].text, /Lectura del prospecto/);
            assert.ok(!JSON.stringify(started).includes('"rpta"'));
            assert.equal(new Date(started.end_exam) - new Date(started.start_exam), 45 * 60_000);

            await api('put', `/intentos/${started.attempt_id}/respuestas`, user, { answers: { pq1: 'A', pq2: 'A' } }).expect(200);
            const done = (await api('post', `/intentos/${started.attempt_id}/finalizar`, user, {}).expect(200)).body.data;

            // 1 correcta (A), 1 incorrecta (la clave es B): 1*2 - 1*0.5 = 1.5; conversion = P*2 + 10.
            assert.deepEqual([done.correct, done.incorrect, done.score, done.score_conversion], [1, 1, 1.5, 13]);

            const { data } = (await get('/simulacro-prospecto/resultados', user).expect(200)).body;
            assert.equal(data.ranking.me.score_conversion, 13);
            assert.deepEqual(data.by_area.map((area) => [area.area, area.score]), [['Matemática', 1.5]]);
        });

        it('el solucionario de un prospecto usa la clave del banco', async () => {
            const user = await enroll('simulacro-prospecto');
            const { attempt_id: attemptId } = (await api('post', '/simulacro-prospecto/iniciar', user).expect(200)).body.data;
            await api('post', `/intentos/${attemptId}/finalizar`, user, { answers: { pq2: 'B' } }).expect(200);

            const items = (await get('/simulacro-prospecto/solucionario', user).expect(200)).body.data.items;
            const pq2 = items.find((item) => item.id === 'pq2');
            assert.deepEqual([pq2.correct, pq2.selected, pq2.is_correct], ['B', 'B', true]);
            assert.match(pq2.explanation, /Exp pq2/);
        });
    });
});
