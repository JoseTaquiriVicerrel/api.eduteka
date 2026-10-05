import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedPractices } from './helpers/seed.js';

const FORBIDDEN_KEYS = ['"rpta"', '"resolution"', '"options_answers"', '"total_answers"'];

describe('practicas', () => {
    let ctx;
    let student;
    let teacher;
    let owner;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        [student, teacher, owner] = [await createUser(ctx), await createUser(ctx, { account_type: 'Profesor' }), await createUser(ctx)];
        await seedPractices(ctx, owner.session.user.id);
        // Variante del texto del area "Lenguaje": las listas guardan el texto de la pregunta.
        await ctx.mongoose.connection.db.collection('questions').insertOne({
            _id: 'q9', area: 'LENGUAJE', area_id: 'area-len', topic: 'Sinónimos', verified: false, rpta: 'A', question: '<p>x</p>', options: { A: 'a' },
        });
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const api = (path) => `/api/v1${path}`;
    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const assertNoSecrets = (body) => {
        const json = JSON.stringify(body);
        for (const key of FORBIDDEN_KEYS) assert.ok(!json.includes(key), `la respuesta expone ${key}`);
    };

    describe('GET /practicas-area/temas', () => {
        it('es publico y devuelve los temas con su conteo', async () => {
            const res = await request(ctx.app).get(api('/practicas-area/temas?area=matematica')).expect(200);
            assert.deepEqual(res.body.data, [
                { topic: 'Álgebra', count: 2 },
                { topic: 'Aritmética', count: 1 },
                { topic: 'Geometría', count: 1 },
            ]);
        });

        it('meta: total practicable (igual que /areas), con tema y sin tema', async () => {
            const { meta } = (await request(ctx.app).get(api('/practicas-area/temas?area=matematica')).expect(200)).body;
            const areas = (await request(ctx.app).get(api('/areas')).expect(200)).body.data;
            const count = areas.find((area) => area.slug === 'matematica').count;

            assert.equal(meta.total_questions, count);
            assert.equal(meta.with_topic, 4);
            assert.equal(meta.with_topic + meta.without_topic, meta.total_questions);
        });
    });

    describe('GET /practicas-area/preguntas', () => {
        const generate = (query, user = student) =>
            request(ctx.app).get(api(`/practicas-area/preguntas${query}`)).set(user ? bearer(user) : {});

        it('exige sesion (401); el docente la recibe resuelta y sin gastar cupo', async () => {
            await generate('?area=matematica', null).expect(401);

            const res = await generate('?area=matematica&count=3', teacher).expect(200);
            assert.equal(res.body.meta.answers_visible, true);
            assert.equal(res.body.data.length, 3);
            for (const question of res.body.data) {
                assert.equal(question.answers_visible, true);
                assert.ok(['A', 'B', 'C', 'D', 'E'].includes(question.correct), question.id);
                assert.ok('explanation' in question);
            }
        });

        it('el estudiante nunca recibe la clave ni la bandera', async () => {
            const res = await generate('?area=matematica&count=3').expect(200);
            assert.equal(res.body.meta.answers_visible, undefined);
            assert.ok(res.body.data.every((q) => !('correct' in q) && !('explanation' in q) && !('answers_visible' in q)));
        });

        it('valida los parametros: area obligatoria, count 1-50, filtros desconocidos', async () => {
            await generate('').expect(422);
            await generate('?area=matematica&count=0').expect(422);
            await generate('?area=matematica&count=51').expect(422);
            await generate('?area=matematica&count=abc').expect(422);
            await generate('?area=matematica&foo=1').expect(422);
            await generate('?area=no-existe').expect(404);
        });

        it('genera la cantidad pedida de preguntas distintas, practicables y sin respuesta', async () => {
            const res = await generate('?area=matematica&count=3').expect(200);
            const ids = res.body.data.map((question) => question.id);

            assert.equal(ids.length, 3);
            assert.equal(new Set(ids).size, 3);
            for (const id of ids) assert.ok(['q1', 'q2', 'q3', 'q8'].includes(id), `${id} no es practicable`);
            assert.deepEqual(res.body.meta, { total: 3, requested: 3, quota_remaining: null });
            assert.deepEqual(res.body.data[0].options.map((option) => option.key), ['A', 'B', 'C', 'D', 'E']);
            assertNoSecrets(res.body);
        });

        it('sin count pide 10; si hay menos disponibles, devuelve las que hay', async () => {
            const res = await generate('?area=matematica').expect(200);
            assert.equal(res.body.data.length, 4);
            assert.equal(res.body.meta.requested, 10);
        });

        it('filtra por tema, dificultad e institucion', async () => {
            const topic = await generate('?area=matematica&topic=Geometr%C3%ADa').expect(200);
            assert.deepEqual(topic.body.data.map((q) => q.id), ['q3']);

            const difficulty = await generate('?area=matematica&difficulty=Dif%C3%ADcil').expect(200);
            assert.deepEqual(difficulty.body.data.map((q) => q.id), ['q2']);

            const institution = await generate('?area=matematica&institution=inst-unmsm').expect(200);
            assert.deepEqual(institution.body.data.map((q) => q.id), ['q1']);

            const none = await generate('?area=matematica&topic=Inexistente').expect(200);
            assert.deepEqual(none.body.data, []);
        });
    });

    describe('POST /practicas-area/finalizar', () => {
        const finalize = (body, user = student) =>
            request(ctx.app).post(api('/practicas-area/finalizar')).set(user ? bearer(user) : {}).send(body);
        const base = { area: 'matematica', topic: null, time: 120 };

        it('exige sesion y una cuenta que practique', async () => {
            await finalize({ ...base, question_ids: ['q1'], answers: {} }, null).expect(401);
            await finalize({ ...base, question_ids: ['q1'], answers: {} }, teacher).expect(403);
        });

        it('corrige en el servidor, explica y guarda el intento', async () => {
            const user = await createUser(ctx);
            const res = await finalize({ ...base, question_ids: ['q1', 'q2', 'q3'], answers: { q1: 'B', q2: 'C', q3: null } }, user).expect(201);
            const { data } = res.body;

            assert.deepEqual([data.total, data.correct, data.incorrect, data.not_answered, data.time], [3, 1, 1, 1, 120]);
            assert.deepEqual(data.review.map((item) => [item.question_id, item.selected, item.correct, item.is_correct]), [
                ['q1', 'B', 'B', true],
                ['q2', 'C', 'A', false],
                ['q3', null, 'C', false],
            ]);
            assert.match(data.review[0].explanation, /src="https:\/\/eduteka\.test\/images\/questions\/r1\.png"/);
            assert.equal(data.review[1].explanation, null);

            const attempt = await db('practiceattempts').findOne({ _id: data.attempt_id });
            assert.equal(attempt.user_id, user.session.user.id);
            assert.equal(attempt.source, 'area');
            assert.equal(attempt.area_id, 'area-mat');
            assert.deepEqual(attempt.answers, { q1: 'B', q2: 'C', q3: null });
            assert.deepEqual([attempt.total_questions, attempt.questions_correct, attempt.questions_incorrect, attempt.questions_not_answered, attempt.time], [3, 1, 1, 1, 120]);
        });

        it('registra en la comunidad solo las respondidas, una vez por usuario y pregunta', async () => {
            const user = await createUser(ctx);
            const before = await db('questions').findOne({ _id: 'q8' });

            await finalize({ ...base, question_ids: ['q8', 'q3'], answers: { q8: 'A', q3: null } }, user).expect(201);

            const after = await db('questions').findOne({ _id: 'q8' });
            assert.equal(after.total_answers, before.total_answers + 1);
            assert.equal(after.options_answers.A, before.options_answers.A + 1);
            const rows = await db('useranswers').find({ user_id: user.session.user.id }).toArray();
            assert.deepEqual(rows.map((row) => [row.question_id, row.answer]), [['q8', 'A']]);
        });

        it('si ya habia respondido esa pregunta, el voto se mueve (no se suma otro)', async () => {
            const user = await createUser(ctx);
            await request(ctx.app).post(api('/preguntas/q2/responder')).set(bearer(user)).send({ selected: 'A' }).expect(200);
            const before = await db('questions').findOne({ _id: 'q2' });

            await finalize({ ...base, question_ids: ['q2'], answers: { q2: 'D' } }, user).expect(201);

            const after = await db('questions').findOne({ _id: 'q2' });
            assert.equal(after.total_answers, before.total_answers);
            assert.equal(after.options_answers.A, before.options_answers.A - 1);
            assert.equal(after.options_answers.D, before.options_answers.D + 1);
        });

        it('reenviar el mismo cierre devuelve el mismo intento (200) sin duplicar nada', async () => {
            const user = await createUser(ctx);
            const body = { ...base, question_ids: ['q1', 'q2'], answers: { q1: 'B', q2: 'A' } };

            const first = await finalize(body, user).expect(201);
            const q1 = await db('questions').findOne({ _id: 'q1' });
            const again = await finalize({ ...body, answers: { q2: 'a', q1: 'b' } }, user).expect(200); // mismo contenido, otro orden/mayusculas

            assert.equal(again.body.data.attempt_id, first.body.data.attempt_id);
            assert.equal(await db('practiceattempts').countDocuments({ user_id: user.session.user.id }), 1);
            assert.equal((await db('questions').findOne({ _id: 'q1' })).total_answers, q1.total_answers);

            // Con otras respuestas es un intento nuevo.
            const different = await finalize({ ...body, answers: { q1: 'A', q2: 'A' } }, user).expect(201);
            assert.notEqual(different.body.data.attempt_id, first.body.data.attempt_id);
        });

        it('dos cierres simultaneos no duplican el intento', async () => {
            const user = await createUser(ctx);
            const body = { ...base, question_ids: ['q3'], answers: { q3: 'C' } };

            const results = await Promise.all([finalize(body, user), finalize(body, user)]);
            const statuses = results.map((res) => res.status).sort();
            assert.equal(statuses.filter((status) => status === 201).length, 1, `estados: ${statuses}`);
            assert.ok(statuses.every((status) => [200, 201, 409].includes(status)));
            assert.equal(await db('practiceattempts').countDocuments({ user_id: user.session.user.id }), 1);
        });

        it('preguntas que ya no se sirven cuentan como no respondidas; si ninguna se sirve, 422', async () => {
            const user = await createUser(ctx);
            // q4 sin verificar, 'nada' inexistente y q7 (otra area).
            const res = await finalize({ ...base, question_ids: ['q1', 'q4', 'nada', 'q7'], answers: { q1: 'A', q7: 'D' } }, user).expect(201);
            assert.deepEqual([res.body.data.total, res.body.data.incorrect, res.body.data.not_answered], [4, 1, 3]);
            assert.equal(res.body.data.review.find((item) => item.question_id === 'q7').selected, null);

            const none = await finalize({ ...base, question_ids: ['q4', 'nada'], answers: {} }, user).expect(422);
            assert.equal(none.body.error.details[0].field, 'question_ids');
        });

        it('una letra que la pregunta no tiene cuenta como incorrecta y no vota', async () => {
            const user = await createUser(ctx);
            const res = await finalize({ ...base, question_ids: ['q1'], answers: { q1: 'Z' } }, user).expect(201);
            assert.equal(res.body.data.incorrect, 1);
            assert.equal(await db('useranswers').countDocuments({ user_id: user.session.user.id }), 0);
        });

        it('valida el cuerpo', async () => {
            const user = await createUser(ctx);
            await finalize({ ...base, question_ids: [], answers: {} }, user).expect(422);
            await finalize({ ...base, question_ids: ['q1', 'q1'], answers: {} }, user).expect(422);
            await finalize({ ...base, question_ids: Array.from({ length: 51 }, (_, i) => `id${i}`), answers: {} }, user).expect(422);
            await finalize({ ...base, question_ids: ['q1'], answers: { q1: 'ABCD' } }, user).expect(422);
            await finalize({ ...base, question_ids: ['q1'], answers: { q1: 5 } }, user).expect(422);
            await finalize({ ...base, question_ids: ['q1'], answers: {}, time: -1 }, user).expect(422);
            await finalize({ ...base, question_ids: ['q1'], answers: {}, extra: true }, user).expect(422);
            await finalize({ question_ids: ['q1'], answers: {} }, user).expect(422); // sin area
            await finalize({ ...base, area: 'no-existe', question_ids: ['q1'], answers: {} }, user).expect(404);
        });

        it('rechaza respuestas de preguntas que no estan en la practica', async () => {
            const user = await createUser(ctx);
            const res = await finalize({ ...base, question_ids: ['q1'], answers: { q2: 'A' } }, user).expect(422);
            assert.equal(res.body.error.details[0].field, 'answers');
        });

        it('time es opcional (0 por defecto)', async () => {
            const user = await createUser(ctx);
            const res = await finalize({ area: 'matematica', question_ids: ['q3'], answers: { q3: 'C' } }, user).expect(201);
            assert.equal(res.body.data.time, 0);
        });
    });

    describe('GET /practicas', () => {
        const list = (query = '') => request(ctx.app).get(api(`/practicas${query}`));

        it('lista las publicas, la mas reciente primero, sin las privadas', async () => {
            const res = await list().expect(200);
            assert.deepEqual(res.body.data.map((practice) => practice.slug), ['algebra-basica', 'lenguaje-1']);
            assert.deepEqual(res.body.meta, { page: 1, limit: 20, total: 2, has_more: false });
            assert.deepEqual(res.body.data[0], {
                id: 'p1', name: 'Álgebra básica', slug: 'algebra-basica', description: 'Primeros pasos',
                count_questions: 5, favorites: 2, areas: [{ name: 'Matemática', count: 3 }],
            });
            assertNoSecrets(res.body);
        });

        it('busca por nombre (el texto es literal, no una expresion regular)', async () => {
            const found = await list('?q=lgebra').expect(200);
            assert.deepEqual(found.body.data.map((p) => p.slug), ['algebra-basica']);

            const regexChars = await list('?q=(nivel').expect(200);
            assert.deepEqual(regexChars.body.data.map((p) => p.slug), ['lenguaje-1']);

            await list('?q=.*').expect(200).then((res) => assert.equal(res.body.data.length, 0));
        });

        it('filtra por area aunque la lista guarde otra variante del texto del area', async () => {
            const math = await list('?area=matematica').expect(200);
            assert.deepEqual(math.body.data.map((p) => p.slug), ['algebra-basica']);

            // La lista dice "LENGUAJE" y el catalogo "Lenguaje".
            const language = await list('?area=lenguaje').expect(200);
            assert.deepEqual(language.body.data.map((p) => p.slug), ['lenguaje-1']);

            await list('?area=no-existe').expect(404);
        });

        it('pagina y valida', async () => {
            const page = await list('?limit=1&page=2').expect(200);
            assert.deepEqual(page.body.data.map((p) => p.slug), ['lenguaje-1']);
            assert.equal(page.body.meta.has_more, false);
            await list('?limit=51').expect(422);
            await list('?x=1').expect(422);
        });
    });

    describe('GET /practicas/:slug', () => {
        const detail = (slug, user) => request(ctx.app).get(api(`/practicas/${slug}`)).set(user ? bearer(user) : {});

        it('exige sesion (igual que la web), tambien para una lista publica', async () => {
            const res = await detail('algebra-basica').expect(401);
            assert.equal(res.body.error.code, 'UNAUTHENTICATED');
        });

        it('devuelve las preguntas practicables de la lista, en su orden y sin respuesta', async () => {
            const res = await detail('algebra-basica', student).expect(200);
            assert.equal(res.body.data.name, 'Álgebra básica');
            assert.equal(res.body.data.count_questions, 3); // q4 y 'zzz' no se sirven
            assert.deepEqual(res.body.data.questions.map((q) => q.id), ['q1', 'q2', 'q3']);
            assertNoSecrets(res.body);
        });

        it('el docente ve la practica resuelta: clave, explicacion y answers_visible', async () => {
            const res = await detail('algebra-basica', teacher).expect(200);
            assert.equal(res.body.data.answers_visible, true);
            const q1 = res.body.data.questions.find((q) => q.id === 'q1');
            assert.equal(q1.correct, 'B');
            assert.match(q1.explanation, /Porque sí/);
            assert.equal(q1.answers_visible, true);

            // Y no puede finalizarla: no genera intentos.
            const finalize = await request(ctx.app).post(api('/practicas/algebra-basica/finalizar')).set(bearer(teacher)).send({ answers: {}, time: 1 }).expect(403);
            assert.equal(finalize.body.error.code, 'CAPABILITY_REQUIRED');
        });

        it('una lista privada solo la ve su dueño; para el resto no existe', async () => {
            await detail('borrador-privado').expect(401);
            await detail('borrador-privado', student).expect(404);
            const res = await detail('borrador-privado', owner).expect(200);
            assert.deepEqual(res.body.data.questions.map((q) => q.id), ['q1']);
        });

        it('slug inexistente -> 404', async () => {
            await detail('no-existe', student).expect(404);
        });
    });

    describe('POST /practicas/:slug/finalizar', () => {
        const finalize = (slug, body, user = student) =>
            request(ctx.app).post(api(`/practicas/${slug}/finalizar`)).set(user ? bearer(user) : {}).send(body);

        it('exige sesion y una cuenta que practique; slug inexistente o privada ajena -> 404', async () => {
            await finalize('algebra-basica', { answers: {} }, null).expect(401);
            await finalize('algebra-basica', { answers: {} }, teacher).expect(403);
            await finalize('no-existe', { answers: {} }).expect(404);
            await finalize('borrador-privado', { answers: {} }).expect(404);
        });

        it('corrige toda la lista (las no respondidas cuentan) y guarda el intento de tipo lista', async () => {
            const user = await createUser(ctx);
            const res = await finalize('algebra-basica', { answers: { q1: 'B', q2: 'A' }, time: 300 }, user).expect(201);
            const { data } = res.body;

            assert.deepEqual([data.total, data.correct, data.incorrect, data.not_answered, data.time], [3, 2, 0, 1, 300]);
            assert.deepEqual(data.review.map((item) => item.question_id), ['q1', 'q2', 'q3']);

            const attempt = await db('practiceattempts').findOne({ _id: data.attempt_id });
            assert.equal(attempt.source, 'lista');
            assert.equal(attempt.practice_id, 'p1');
            assert.equal(attempt.practice_slug, 'algebra-basica');
            assert.equal(attempt.total_questions, 3);
        });

        it('el dueño puede resolver su lista privada', async () => {
            const res = await finalize('borrador-privado', { answers: { q1: 'B' } }, owner).expect(201);
            assert.equal(res.body.data.correct, 1);
        });

        it('rechaza respuestas de preguntas que la practica no sirve (q4)', async () => {
            const user = await createUser(ctx);
            const res = await finalize('algebra-basica', { answers: { q4: 'A' } }, user).expect(422);
            assert.equal(res.body.error.details[0].field, 'answers');
        });

        it('reenviar el cierre devuelve el mismo intento', async () => {
            const user = await createUser(ctx);
            const first = await finalize('algebra-basica', { answers: { q1: 'B' }, time: 10 }, user).expect(201);
            const again = await finalize('algebra-basica', { answers: { q1: 'B' }, time: 10 }, user).expect(200);
            assert.equal(again.body.data.attempt_id, first.body.data.attempt_id);
        });
    });
});
