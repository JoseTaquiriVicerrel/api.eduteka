import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

const API = '/api/v1';

describe('GET /progreso', () => {
    let ctx;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const progress = (user) => request(ctx.app).get(`${API}/progreso`).set(user ? bearer(user) : {});
    const answer = (user, id, selected) =>
        request(ctx.app).post(`${API}/preguntas/${id}/responder`).set(bearer(user)).send({ selected });
    const today = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10); // dia de Lima

    it('exige sesion y una cuenta de estudiante (los docentes no acumulan progreso)', async () => {
        await progress(null).expect(401);
        const teacher = await createUser(ctx, { account_type: 'Profesor' });
        const res = await progress(teacher).expect(403);
        assert.equal(res.body.error.code, 'CAPABILITY_REQUIRED');
    });

    it('un usuario sin actividad recibe ceros y listas vacias', async () => {
        const user = await createUser(ctx);
        const { data } = (await progress(user).expect(200)).body;

        assert.equal(data.has_activity, false);
        assert.deepEqual(data.summary, { attempts: 0, questions_answered: 0, accuracy: null, study_time: 0 });
        assert.deepEqual([data.by_area, data.weak_topics, data.simulacra, data.recent_attempts], [[], [], [], []]);
        assert.equal(data.trend.length, 30);
        assert.equal(data.trend.at(-1).date, today());
        assert.equal(data.streak.current, 0);
        assert.equal(data.week_dots.length, 7);
    });

    it('calcula respondidas, aciertos, area, racha y tendencia a partir de las respuestas', async () => {
        const user = await createUser(ctx);
        await answer(user, 'q1', 'B').expect(200); // correcta
        await answer(user, 'q2', 'C').expect(200); // incorrecta (la clave es A)
        await answer(user, 'q3', 'C').expect(200); // correcta

        const { data } = (await progress(user).expect(200)).body;

        assert.equal(data.has_activity, true);
        assert.equal(data.summary.questions_answered, 3);
        assert.equal(data.summary.accuracy, 0.667);
        assert.deepEqual(data.today, { answered: 3, practice: 3, simulacro: 0, accuracy: 0.667 });
        assert.equal(data.streak.current, 1);
        assert.equal(data.streak.status, 'today');

        assert.equal(data.by_area.length, 1);
        assert.equal(data.by_area[0].area, 'Matemática');
        assert.equal(data.by_area[0].answered, 3);
        assert.equal(data.by_area[0].accuracy, 0.667);
        // 3 respondidas de las 4 practicables del area (q1, q2, q3, q8).
        assert.deepEqual(data.by_area[0].coverage, { done: 3, total: 4, pct: 75 });

        const last = data.trend.at(-1);
        assert.deepEqual([last.date, last.answered, last.accuracy], [today(), 3, 0.667]);
        assert.equal(data.trend[0].answered, 0);
        assert.equal(data.trend[0].accuracy, null); // un dia sin preguntas no es 0%
    });

    it('se actualiza al instante cuando el usuario practica desde la API (invalida el cache)', async () => {
        const user = await createUser(ctx);
        await answer(user, 'q1', 'B').expect(200);
        assert.equal((await progress(user).expect(200)).body.data.summary.questions_answered, 1);

        await answer(user, 'q2', 'A').expect(200);
        assert.equal((await progress(user).expect(200)).body.data.summary.questions_answered, 2);

        await request(ctx.app).post(`${API}/practicas-area/finalizar`).set(bearer(user))
            .send({ area: 'matematica', question_ids: ['q3'], answers: { q3: 'C' }, time: 60 }).expect(201);
        const after = (await progress(user).expect(200)).body.data;
        assert.equal(after.summary.questions_answered, 3);
        assert.equal(after.summary.attempts, 1);
        assert.equal(after.summary.study_time, 60);
    });

    it('cachea 5 minutos: lo que escriba otro sistema (la web) se ve al vencer el cache', async () => {
        const user = await createUser(ctx);
        await answer(user, 'q1', 'B').expect(200);
        await progress(user).expect(200);

        await db('useranswers').insertOne({ _id: 'web-1', user_id: user.session.user.id, question_id: 'q7', answer: 'D', created_at: new Date(), updated_at: new Date() });
        assert.equal((await progress(user).expect(200)).body.data.summary.questions_answered, 1);

        ctx.kv.flushMemory(); // vence el cache
        assert.equal((await progress(user).expect(200)).body.data.summary.questions_answered, 2);
    });

    it('cada usuario ve solo lo suyo', async () => {
        const one = await createUser(ctx);
        const two = await createUser(ctx);
        await answer(one, 'q1', 'B').expect(200);

        assert.equal((await progress(two).expect(200)).body.data.summary.questions_answered, 0);
    });

    describe('temas a reforzar', () => {
        it('solo entran los temas con al menos 10 respuestas corregibles, de menor a mayor acierto', async () => {
            const user = await createUser(ctx);
            const id = user.session.user.id;
            const questions = Array.from({ length: 14 }, (_, i) => ({
                _id: `tf${i}`, area: 'Matemática', area_id: 'area-mat', topic: i < 12 ? 'Tema flojo' : 'Tema corto',
                verified: true, rpta: 'A', question: 'x', options: { A: 'a', B: 'b' },
            }));
            await db('questions').insertMany(questions);
            const now = new Date();
            // Tema flojo: 12 respuestas, 2 correctas. Tema corto: 2 respuestas (no llega al minimo).
            await db('useranswers').insertMany(questions.map((q, i) => ({
                _id: `ua-${id}-${i}`, user_id: id, question_id: q._id, answer: i < 2 || i >= 12 ? 'A' : 'B', created_at: now, updated_at: now,
            })));

            const { data } = (await progress(user).expect(200)).body;
            assert.deepEqual(data.weak_topics, [{ topic: 'Tema flojo', area: 'Matemática', area_id: 'area-mat', accuracy: 0.167, answered: 12 }]);
        });
    });

    describe('simulacros e historial', () => {
        it('lista los simulacros calificados, cuenta el tiempo de estudio y los intentos recientes', async () => {
            const user = await createUser(ctx);
            const id = user.session.user.id;
            const start = new Date(Date.UTC(2026, 3, 1, 15, 0, 0));
            await db('simulacrums').insertOne({ _id: 'sim-p', title: 'Simulacro Abril', slug: 'simulacro-abril' });
            await db('usersimulacrums').insertOne({
                _id: 'us-p', user_id: id, simulacrum_id: 'sim-p', finished: true, attempt_number: 1,
                questions_correct: 30, questions_incorrect: 10, questions_not_answered: 5, score: 100, score_conversion: 12.5,
                start_exam: start, exam_finished: new Date(start.getTime() + 3600_000), created_at: start,
            });
            // El mismo intento archivado tambien: no debe contarse dos veces.
            await db('simulacrumattempts').insertOne({
                _id: 'sa-p', user_simulacrum_id: 'us-p', user_id: id, simulacrum_id: 'sim-p', attempt_number: 1,
                questions_correct: 30, questions_incorrect: 10, questions_not_answered: 5, score: 100,
                start_exam: start, exam_finished: new Date(start.getTime() + 3600_000), created_at: start,
            });

            const { data } = (await progress(user).expect(200)).body;

            assert.equal(data.summary.attempts, 1);
            assert.equal(data.summary.questions_answered, 40);
            assert.equal(data.summary.accuracy, 0.75);
            assert.equal(data.summary.study_time, 3600);
            assert.deepEqual(data.simulacra, [{
                slug: 'simulacro-abril', title: 'Simulacro Abril', attempt_number: 1, score: 100, score_conversion: 12.5,
                accuracy: 0.75, date: new Date(start.getTime() + 3600_000).toISOString(),
            }]);
            assert.equal(data.recent_attempts.length, 1);
            assert.equal(data.recent_attempts[0].type, 'simulacro');
        });
    });
});
