import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedPractices } from './helpers/seed.js';
import { suggestNext } from '../src/modules/practices/practice.suggestions.js';

// Que practicar despues de terminar una practica: continuar (mismo tema / siguiente de la serie) o explorar.
describe('practicas: sugerencias al terminar', () => {
    let ctx;
    let owner;

    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const api = (path) => `/api/v1${path}`;

    const list = (id, slug, extra = {}) => ({
        _id: id, name: `Lista ${slug}`, slug, public: true, questions: ['q7'], areas: [{ name: 'LENGUAJE', count: 1 }],
        count_questions: 1, favorites: 0, created_at: new Date(Date.UTC(2026, 0, 1)), ...extra,
    });
    const serie = (n, extra = {}) => list(`ser-${n}`, `sinonimos-${n}`, { suggestion: { key: 'A:sinonimos', via: 'A', series: n }, ...extra });

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        owner = await createUser(ctx);
        await seedPractices(ctx, owner.session.user.id);
        await db('userquestionslists').insertMany([
            serie(1), serie(2), serie(3),
            list('mat-2', 'geometria-1', { name: 'Geometría 1', questions: ['q3'], areas: [{ name: 'Matemática', count: 1 }], favorites: 7 }),
            list('priv-len', 'lenguaje-privado', { public: false, user: owner.session.user.id }),
        ]);
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const finishList = (slug, user, answers = {}) =>
        request(ctx.app).post(api(`/practicas/${slug}/finalizar`)).set(bearer(user)).send({ answers, time: 30 });
    const finishArea = (body, user) =>
        request(ctx.app).post(api('/practicas-area/finalizar')).set(bearer(user)).send({ area: 'matematica', time: 30, ...body });
    const slugs = (items) => items.map((item) => item.slug);

    describe('al terminar una practica guardada', () => {
        it('continuar: la siguiente de la serie, en orden, sin repetir la que ya resolvio', async () => {
            const user = await createUser(ctx);
            const { suggestions } = (await finishList('sinonimos-1', user, { q7: 'D' }).expect(201)).body.data;

            assert.deepEqual(slugs(suggestions.continue.slice(0, 2)), ['sinonimos-2', 'sinonimos-3']);
            assert.deepEqual(suggestions.continue.slice(0, 2).map((item) => item.reason), ['next_in_series', 'next_in_series']);
            assert.ok(suggestions.continue.every((item) => item.type === 'list'));
            assert.ok(!slugs(suggestions.continue).includes('sinonimos-1'), 'no se sugiere la que acaba de terminar');

            // Si ya resolvio la 2, la siguiente es la 3.
            await finishList('sinonimos-2', user, { q7: 'D' }).expect(201);
            const again = (await finishList('sinonimos-1', user, { q7: 'D' }).expect(200)).body.data.suggestions;
            assert.deepEqual(slugs(again.continue).filter((slug) => slug.startsWith('sinonimos-')), ['sinonimos-3']);
        });

        it('cada sugerencia trae lo necesario para abrir la practica', async () => {
            const user = await createUser(ctx);
            const { suggestions } = (await finishList('sinonimos-1', user, { q7: 'D' }).expect(201)).body.data;
            const next = suggestions.continue[0];
            assert.deepEqual(Object.keys(next).sort(), ['areas', 'count_questions', 'description', 'favorites', 'name', 'reason', 'slug', 'type']);
            assert.equal(next.name, 'Lista sinonimos-2');
        });

        it('explorar: practicas de otras areas, las mas guardadas primero', async () => {
            const user = await createUser(ctx);
            const { suggestions } = (await finishList('sinonimos-1', user, { q7: 'D' }).expect(201)).body.data;

            const explore = suggestions.explore;
            assert.ok(explore.length > 0);
            assert.ok(explore.every((item) => item.reason === 'other_area'));
            // Ninguna es del area Lenguaje (la que acaba de practicar).
            assert.ok(explore.every((item) => item.areas.every((area) => area.name !== 'LENGUAJE')));
            assert.equal(explore[0].slug, 'geometria-1'); // 7 favoritos
        });

        it('sin serie: continuar con otras practicas del mismo area', async () => {
            const user = await createUser(ctx);
            const { suggestions } = (await finishList('algebra-basica', user, { q1: 'B' }).expect(201)).body.data;
            assert.deepEqual(slugs(suggestions.continue), ['geometria-1']);
            assert.equal(suggestions.continue[0].reason, 'same_area');
        });

        it('nunca sugiere practicas privadas ni las que ya resolvio', async () => {
            const user = await createUser(ctx);
            await finishList('geometria-1', user, { q3: 'C' }).expect(201);
            const { suggestions } = (await finishList('algebra-basica', user, { q1: 'B' }).expect(201)).body.data;
            const all = slugs([...suggestions.continue, ...suggestions.explore]);

            assert.ok(!all.includes('geometria-1'), 'ya la resolvio');
            assert.ok(!all.includes('lenguaje-privado'), 'es privada');
            assert.ok(!all.includes('borrador-privado'), 'es privada');
            assert.ok(!all.includes('algebra-basica'), 'es la que acaba de terminar');
        });
    });

    describe('al terminar una tanda por area', () => {
        const practicable = (topic) => db('questions').countDocuments({
            origin: { $ne: 'Docente' }, verified: true, rpta: { $exists: true, $ne: null }, area_id: 'area-mat', ...(topic ? { topic } : {}),
        });

        it('continuar: otra tanda del mismo tema, con cuantas preguntas hay', async () => {
            const user = await createUser(ctx);
            const { suggestions } = (await finishArea({ topic: 'Álgebra', question_ids: ['q1', 'q2'], answers: { q1: 'B', q2: 'A' } }, user).expect(201)).body.data;

            assert.equal(suggestions.continue.length, 1);
            assert.deepEqual(suggestions.continue[0], {
                type: 'area',
                reason: 'same_topic',
                area: { id: 'area-mat', slug: 'matematica', name: 'Matemática' },
                topic: 'Álgebra',
                available_questions: await practicable('Álgebra'),
            });
            assert.ok(suggestions.continue[0].available_questions >= 2);
        });

        it('sin tema, continuar con el area', async () => {
            const user = await createUser(ctx);
            const { suggestions } = (await finishArea({ question_ids: ['q1'], answers: { q1: 'B' } }, user).expect(201)).body.data;
            assert.equal(suggestions.continue[0].reason, 'same_area');
            assert.equal(suggestions.continue[0].topic, null);
            assert.equal(suggestions.continue[0].available_questions, await practicable());
        });

        it('explorar: temas del area que aun no practico, y una practica guardada', async () => {
            const user = await createUser(ctx);
            const { suggestions } = (await finishArea({ topic: 'Álgebra', question_ids: ['q1'], answers: { q1: 'B' } }, user).expect(201)).body.data;

            const topics = suggestions.explore.filter((item) => item.type === 'area');
            assert.ok(topics.length > 0);
            assert.ok(topics.every((item) => item.topic !== 'Álgebra'), 'no repite el tema actual');
            // Sin historial, todos son temas nuevos; primero los que tienen mas preguntas.
            assert.ok(topics.every((item) => item.reason === 'new_topic'));
            assert.deepEqual(topics.map((item) => item.available_questions), [...topics.map((item) => item.available_questions)].sort((x, y) => y - x));

            const lists = suggestions.explore.filter((item) => item.type === 'list');
            assert.ok(lists.length >= 1);
            assert.ok(lists.every((item) => item.reason === 'same_area'));
            assert.equal(lists[0].slug, 'geometria-1'); // la mas guardada del area (7 favoritos)
            assert.ok(suggestions.explore.length <= 3);
        });

        it('un tema flojo (< 60 % con 10+ respuestas) se sugiere primero, con su porcentaje', async () => {
            const user = await createUser(ctx);
            await db('practiceattempts').insertMany([
                { _id: 'pa-1', user_id: user.session.user.id, source: 'area', area_id: 'area-mat', topic: 'Geometría', total_questions: 6, questions_correct: 2, created_at: new Date() },
                { _id: 'pa-2', user_id: user.session.user.id, source: 'area', area_id: 'area-mat', topic: 'Geometría', total_questions: 6, questions_correct: 1, created_at: new Date() },
            ]);
            const { suggestions } = (await finishArea({ topic: 'Álgebra', question_ids: ['q1'], answers: { q1: 'B' } }, user).expect(201)).body.data;

            const first = suggestions.explore[0];
            assert.equal(first.topic, 'Geometría');
            assert.equal(first.reason, 'weak_topic');
            assert.equal(first.accuracy, 0.25); // 3 de 12
        });

        it('con pocas respuestas un tema no se considera flojo', async () => {
            const user = await createUser(ctx);
            await db('practiceattempts').insertOne({
                _id: 'pa-3', user_id: user.session.user.id, source: 'area', area_id: 'area-mat', topic: 'Geometría', total_questions: 5, questions_correct: 0, created_at: new Date(),
            });
            const { suggestions } = (await finishArea({ topic: 'Álgebra', question_ids: ['q1'], answers: { q1: 'B' } }, user).expect(201)).body.data;
            const geometry = suggestions.explore.find((item) => item.topic === 'Geometría');
            assert.notEqual(geometry?.reason, 'weak_topic');
        });

        it('el reenvio del mismo cierre (200) tambien trae sugerencias', async () => {
            const user = await createUser(ctx);
            const body = { topic: 'Álgebra', question_ids: ['q1'], answers: { q1: 'B' } };
            const first = (await finishArea(body, user).expect(201)).body.data;
            const second = (await finishArea(body, user).expect(200)).body.data;
            assert.equal(second.attempt_id, first.attempt_id);
            assert.deepEqual(second.suggestions, first.suggestions);
        });

        it('el resto de la respuesta no cambia', async () => {
            const user = await createUser(ctx);
            const { data } = (await finishArea({ question_ids: ['q1', 'q2'], answers: { q1: 'B', q2: 'C' } }, user).expect(201)).body;
            assert.deepEqual([data.total, data.correct, data.incorrect, data.not_answered], [2, 1, 1, 0]);
            assert.ok(Array.isArray(data.review) && data.attempt_id);
        });
    });

    it('si el calculo de sugerencias falla, devuelve vacio y no lanza (el cierre no se rompe)', async () => {
        assert.deepEqual(await suggestNext('list', { user: null, practice: null }), { continue: [], explore: [] });
        assert.deepEqual(await suggestNext('area', { user: null, area: null, topic: null }), { continue: [], explore: [] });
    });
});
