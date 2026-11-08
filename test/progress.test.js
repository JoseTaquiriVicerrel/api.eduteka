import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

const API = '/api/v1';
const WEB_SECRET = 'secreto-web-de-prueba-0123456789abcdef';

describe('GET /progreso', () => {
    let ctx;

    before(async () => {
        ctx = await bootTestApp({ WEB_CLIENT_SECRET: WEB_SECRET });
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
        assert.equal(data.trend_weeks.length, 12);
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

    it('el cliente web no usa el cache: ve al instante lo que escribe el monolito', async () => {
        const user = await createUser(ctx);
        const fromWeb = () => progress(user).set('X-Edk-Client', 'web').set('X-Edk-Client-Secret', WEB_SECRET);
        await answer(user, 'q1', 'B').expect(200);
        assert.equal((await fromWeb().expect(200)).body.data.summary.questions_answered, 1);

        // Como el monolito: directo en la base, sin pasar por la API ni invalidar el cache.
        await db('useranswers').insertOne({ _id: 'web-fresh-1', user_id: user.session.user.id, question_id: 'q7', answer: 'D', created_at: new Date(), updated_at: new Date() });
        const fresh = (await fromWeb().expect(200)).body.data;
        assert.equal(fresh.summary.questions_answered, 2);
        assert.equal(fresh.today.answered, 2);

        // La app sigue con el cache, que la llamada de la web dejo al dia.
        assert.equal((await progress(user).expect(200)).body.data.summary.questions_answered, 2);
        await db('useranswers').insertOne({ _id: 'web-fresh-2', user_id: user.session.user.id, question_id: 'q8', answer: 'A', created_at: new Date(), updated_at: new Date() });
        assert.equal((await progress(user).expect(200)).body.data.summary.questions_answered, 2);

        // Un secreto invalido es la app: tambien usa el cache.
        const forged = await progress(user).set('X-Edk-Client', 'web').set('X-Edk-Client-Secret', 'no-es-el-secreto').expect(200);
        assert.equal(forged.body.data.summary.questions_answered, 2);
        assert.equal((await fromWeb().expect(200)).body.data.summary.questions_answered, 3);
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

    describe('desglose para los graficos de la web', () => {
        it('trend separa practicas y simulacros; trend_weeks trae 12 semanas ISO (lunes de Lima)', async () => {
            const user = await createUser(ctx);
            const id = user.session.user.id;
            await answer(user, 'q1', 'B').expect(200);
            await answer(user, 'q2', 'C').expect(200);
            const start = new Date(Date.now() - 3_600_000);
            await db('usersimulacrums').insertOne({
                _id: `us-trend-${id}`, user_id: id, simulacrum_id: 'sim-trend', finished: true, attempt_number: 1,
                questions_correct: 4, questions_incorrect: 2, questions_not_answered: 0, score: 10,
                results: { Lenguaje: { questions_correct: 4, questions_incorrect: 2, questions_count: 6 } },
                start_exam: start, exam_finished: new Date(), created_at: start,
            });

            const { data } = (await progress(user).expect(200)).body;

            const last = data.trend.at(-1);
            assert.deepEqual([last.date, last.answered, last.practice, last.simulacro], [today(), 8, 2, 6]);
            assert.ok(data.trend.every((day) => day.answered === day.practice + day.simulacro));

            assert.equal(data.trend_weeks.length, 12);
            const week = data.trend_weeks.at(-1);
            assert.deepEqual([week.answered, week.practice, week.simulacro], [8, 2, 6]);
            assert.equal(week.accuracy, 0.625); // 5 aciertos de 8 corregibles
            assert.ok(data.trend_weeks.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.week_start)));
            const monday = (key) => new Date(`${key}T00:00:00Z`).getUTCDay();
            assert.ok(data.trend_weeks.every((w) => monday(w.week_start) === 1), 'cada semana empieza en lunes');
            assert.ok(week.week_start <= today() && today() < new Date(new Date(`${week.week_start}T00:00:00Z`).getTime() + 7 * 86_400_000).toISOString().slice(0, 10));
            assert.deepEqual(data.trend_weeks.map((w) => w.week_start), [...data.trend_weeks.map((w) => w.week_start)].sort());
        });

        it('by_area[].keyed cuenta las respuestas corregibles del area (practicas y simulacros)', async () => {
            const user = await createUser(ctx);
            const id = user.session.user.id;
            await answer(user, 'q7', 'A').expect(200); // Lenguaje, con clave
            await db('questions').insertOne({ _id: 'q-sin-clave-len', area: 'Lenguaje', area_id: 'area-len', topic: 'Sinónimos', verified: true, rpta: '', question: 'x', options: { A: 'a' } });
            await db('useranswers').insertOne({ _id: `ua-sc-${id}`, user_id: id, question_id: 'q-sin-clave-len', answer: 'A', created_at: new Date(), updated_at: new Date() });
            const start = new Date(Date.UTC(2026, 4, 1, 15, 0, 0));
            await db('usersimulacrums').insertOne({
                _id: `us-keyed-${id}`, user_id: id, simulacrum_id: 'sim-keyed', finished: true, attempt_number: 1,
                questions_correct: 3, questions_incorrect: 1, questions_not_answered: 0, score: 10,
                results: { Lenguaje: { questions_correct: 3, questions_incorrect: 1, questions_count: 4 } },
                start_exam: start, exam_finished: new Date(start.getTime() + 600_000), created_at: start,
            });

            const area = (await progress(user).expect(200)).body.data.by_area.find((row) => row.area_id === 'area-len');
            assert.equal(area.answered, 2 + 4); // dos de practica (una sin clave) y cuatro de simulacro
            assert.equal(area.keyed, 1 + 4); // la pregunta sin clave no es corregible
        });
    });

    describe('detalle por area (temas y simulacros)', () => {
        // Preguntas de Lenguaje en `topics` (nombre -> [respuestas, correctas]); `unkeyed` sin clave.
        const seedTopics = async (user, prefix, topics, { unkeyed = {} } = {}) => {
            const id = user.session.user.id;
            const questions = [];
            const answers = [];
            const now = new Date();
            for (const [topic, [total, correct]] of Object.entries(topics)) {
                for (let i = 0; i < total; i += 1) {
                    const qid = `${prefix}-${questions.length}`;
                    const keyed = i >= (unkeyed[topic] ?? 0);
                    questions.push({ _id: qid, area: 'Lenguaje', area_id: 'area-len', topic, verified: true, rpta: keyed ? 'A' : '', question: 'x', options: { A: 'a', B: 'b' } });
                    answers.push({ _id: `ua-${qid}`, user_id: id, question_id: qid, answer: i < correct + (unkeyed[topic] ?? 0) ? 'A' : 'B', created_at: now, updated_at: now });
                }
            }
            await db('questions').insertMany(questions);
            await db('useranswers').insertMany(answers);
        };
        const lenguaje = (data) => data.by_area.find((area) => area.area_id === 'area-len');

        it('cada area trae sus temas con respondidas, corregibles, acierto y el tema a reforzar', async () => {
            const user = await createUser(ctx);
            // Sintaxis: 7 respuestas, 1 sin clave; de las 6 corregibles, 1 correcta. Ortografia: 6, 5 correctas.
            await seedTopics(user, 'tt', { Sintaxis: [7, 1], Ortografía: [6, 5] }, { unkeyed: { Sintaxis: 1 } });

            const area = lenguaje((await progress(user).expect(200)).body.data);
            assert.deepEqual(area.topics, [
                { topic: 'Sintaxis', answered: 7, keyed: 6, accuracy: 0.167, weak: true },
                { topic: 'Ortografía', answered: 6, keyed: 6, accuracy: 0.833, weak: false },
            ]);
            assert.equal(area.more_topics, 0);
            assert.equal(area.simulacro_answered, 0);
        });

        it('con mas temas que el tope, more_topics cuenta los que no se muestran', async () => {
            const user = await createUser(ctx);
            const topics = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Tema ${String(i).padStart(2, '0')}`, [11 - i, 0]]));
            await seedTopics(user, 'tm', topics);

            const area = lenguaje((await progress(user).expect(200)).body.data);
            assert.equal(area.topics.length, 8);
            assert.equal(area.topics[0].topic, 'Tema 00'); // los mas respondidos primero
            assert.equal(area.more_topics, 3);
        });

        it('simulacro_answered cuenta las respuestas de simulacro del area (incluidas en answered)', async () => {
            const user = await createUser(ctx);
            const start = new Date(Date.UTC(2026, 4, 1, 15, 0, 0));
            await db('usersimulacrums').insertOne({
                _id: `us-area-${user.session.user.id}`, user_id: user.session.user.id, simulacrum_id: 'sim-area', finished: true, attempt_number: 1,
                questions_correct: 4, questions_incorrect: 2, questions_not_answered: 1, score: 10,
                results: { Lenguaje: { questions_correct: 4, questions_incorrect: 2, questions_count: 7 } },
                start_exam: start, exam_finished: new Date(start.getTime() + 600_000), created_at: start,
            });
            await answer(user, 'q7', 'A').expect(200); // Lenguaje, tema Sinónimos

            const area = lenguaje((await progress(user).expect(200)).body.data);
            assert.equal(area.simulacro_answered, 6);
            assert.equal(area.answered, 7);
            // Los resultados de simulacro no bajan a tema: solo aparece el de la pregunta respondida.
            assert.deepEqual(area.topics.map((topic) => [topic.topic, topic.answered]), [['Sinónimos', 1]]);
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
                total: 45, correct: 30, incorrect: 10, not_answered: 5,
                accuracy: 0.75, accuracy_total: 0.667, date: new Date(start.getTime() + 3600_000).toISOString(),
            }]);
            assert.equal(data.recent_attempts.length, 1);
            assert.equal(data.recent_attempts[0].type, 'simulacro');
        });
    });
});
