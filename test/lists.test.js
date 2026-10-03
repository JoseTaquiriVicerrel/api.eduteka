import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

const API = '/api/v1';
const FORBIDDEN_KEYS = ['"rpta"', '"resolution"', '"options_answers"', '"total_answers"'];

describe('mis-listas', () => {
    let ctx;
    let user;
    let other;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        // 40 preguntas extra, todas practicables, para probar topes y publicacion.
        await ctx.mongoose.connection.db.collection('questions').insertMany(
            Array.from({ length: 40 }, (_, i) => ({
                _id: `x${i}`, area: i % 2 ? 'Lenguaje' : 'Matemática', area_id: i % 2 ? 'area-len' : 'area-mat',
                topic: 'Relleno', verified: true, rpta: 'A', question: `<p>Pregunta ${i}</p>`, options: { A: 'a', B: 'b' },
                created_at: new Date(Date.UTC(2025, 0, 1 + i)),
            })),
        );
        [user, other] = [await createUser(ctx), await createUser(ctx)];
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const call = (method, path, who, body) => request(ctx.app)[method](`${API}/mis-listas${path}`).set(who ? bearer(who) : {}).send(body);
    const ids = (from, to) => Array.from({ length: to - from }, (_, i) => `x${from + i}`);
    const create = async (body, who = user) => (await call('post', '', who, body).expect(201)).body.data;
    const assertNoSecrets = (body) => {
        const json = JSON.stringify(body);
        for (const key of FORBIDDEN_KEYS) assert.ok(!json.includes(key), `expone ${key}`);
    };

    it('todas las rutas exigen sesion', async () => {
        await call('get', '', null).expect(401);
        await call('post', '', null, { name: 'x' }).expect(401);
        await call('get', '/abc', null).expect(401);
        await call('patch', '/abc', null, { name: 'x' }).expect(401);
        await call('delete', '/abc', null).expect(401);
        await call('post', '/abc/preguntas', null, { question_id: 'q1' }).expect(401);
        await call('delete', '/abc/preguntas/q1', null).expect(401);
    });

    describe('crear y leer', () => {
        it('crea una lista vacia, privada y con slug', async () => {
            const list = await create({ name: '  Mis repasos  ', description: 'Para el viernes' });

            assert.equal(list.name, 'Mis repasos');
            assert.equal(list.description, 'Para el viernes');
            assert.equal(list.public, false);
            assert.equal(list.count_questions, 0);
            assert.match(list.slug, /^mis-repasos-[0-9a-f]{12}$/);
            assert.equal((await db('userquestionslists').findOne({ _id: list.id })).user, user.session.user.id);
        });

        it('crea con preguntas: calcula areas y conteo', async () => {
            const list = await create({ name: 'Mixta', question_ids: ['q1', 'q7', 'q2'] });

            assert.equal(list.count_questions, 3);
            const stored = await db('userquestionslists').findOne({ _id: list.id });
            assert.deepEqual(stored.questions, ['q1', 'q7', 'q2']);
            assert.deepEqual(stored.areas.sort((a, b) => a.name.localeCompare(b.name)), [
                { name: 'Lenguaje', count: 1 },
                { name: 'Matemática', count: 2 },
            ]);
        });

        it('rechaza preguntas que no existen o no se sirven (q4 sin verificar, q5 de docente, q6 sin clave)', async () => {
            const res = await call('post', '', user, { name: 'Mala', question_ids: ['q1', 'q4', 'q5', 'q6', 'nada'] }).expect(422);
            assert.equal(res.body.error.details[0].field, 'question_ids');
            for (const id of ['q4', 'q5', 'q6', 'nada']) assert.match(res.body.error.details[0].message, new RegExp(id));
            assert.equal(await db('userquestionslists').countDocuments({ name: 'Mala' }), 0);
        });

        it('valida el cuerpo', async () => {
            await call('post', '', user, {}).expect(422);
            await call('post', '', user, { name: '   ' }).expect(422);
            await call('post', '', user, { name: 'x'.repeat(121) }).expect(422);
            await call('post', '', user, { name: 'x', public: true }).expect(422); // se publica con PATCH
            await call('post', '', user, { name: 'x', question_ids: ['q1', 'q1'] }).expect(422);
            await call('post', '', user, { name: 'x', user: 'otro' }).expect(422);
        });

        it('lista solo las propias, la mas reciente primero, y marca cuales contienen una pregunta', async () => {
            const mine = await createUser(ctx);
            const first = await create({ name: 'Primera', question_ids: ['q1'] }, mine);
            const second = await create({ name: 'Segunda' }, mine);
            await create({ name: 'De otro' }, other);

            const res = await call('get', `?question_id=q1`, mine).expect(200);
            assert.deepEqual(res.body.data.map((list) => list.id), [second.id, first.id]);
            assert.deepEqual(res.body.data.map((list) => list.contains), [false, true]);
            assert.deepEqual(res.body.meta, { page: 1, limit: 20, total: 2, has_more: false });

            const plain = await call('get', '', mine).expect(200);
            assert.equal(plain.body.data[0].contains, undefined);
        });

        it('el detalle trae las preguntas en su orden y sin respuesta', async () => {
            const list = await create({ name: 'Orden', question_ids: ['q3', 'q1', 'q2'] });
            const res = await call('get', `/${list.id}`, user).expect(200);

            assert.deepEqual(res.body.data.question_ids, ['q3', 'q1', 'q2']);
            assert.deepEqual(res.body.data.questions.map((q) => q.id), ['q3', 'q1', 'q2']);
            assertNoSecrets(res.body);
        });

        it('si una pregunta deja de servirse sigue en question_ids pero no en questions', async () => {
            const list = await create({ name: 'Cambia', question_ids: ['q1', 'q2'] });
            await db('questions').updateOne({ _id: 'q2' }, { $set: { verified: false } });
            try {
                const res = await call('get', `/${list.id}`, user).expect(200);
                assert.deepEqual(res.body.data.question_ids, ['q1', 'q2']);
                assert.deepEqual(res.body.data.questions.map((q) => q.id), ['q1']);
            } finally {
                await db('questions').updateOne({ _id: 'q2' }, { $set: { verified: true } });
            }
        });
    });

    describe('propiedad: una lista ajena no existe', () => {
        it('GET, PATCH, DELETE y manejo de preguntas dan 404 a otro usuario', async () => {
            const list = await create({ name: 'Privada', question_ids: ['q1'] });

            await call('get', `/${list.id}`, other).expect(404);
            await call('patch', `/${list.id}`, other, { name: 'Robada' }).expect(404);
            await call('delete', `/${list.id}`, other).expect(404);
            await call('post', `/${list.id}/preguntas`, other, { question_id: 'q2' }).expect(404);
            await call('delete', `/${list.id}/preguntas/q1`, other).expect(404);

            const stored = await db('userquestionslists').findOne({ _id: list.id });
            assert.equal(stored.name, 'Privada');
            assert.deepEqual(stored.questions, ['q1']);
        });
    });

    describe('PATCH /mis-listas/:id', () => {
        it('renombrar cambia el slug; cambiar solo la descripcion no', async () => {
            const list = await create({ name: 'Original' });

            const same = await call('patch', `/${list.id}`, user, { description: 'Nueva descripcion' }).expect(200);
            assert.equal(same.body.data.slug, list.slug);
            assert.equal(same.body.data.description, 'Nueva descripcion');

            const renamed = await call('patch', `/${list.id}`, user, { name: 'Renombrada' }).expect(200);
            assert.notEqual(renamed.body.data.slug, list.slug);
            assert.match(renamed.body.data.slug, /^renombrada-/);
        });

        it('reemplaza el contenido y el orden, y recalcula areas y conteo', async () => {
            const list = await create({ name: 'Reordenar', question_ids: ['q1', 'q2', 'q3'] });
            const res = await call('patch', `/${list.id}`, user, { questions: ['q3', 'q7'] }).expect(200);

            assert.deepEqual(res.body.data.question_ids, ['q3', 'q7']);
            assert.equal(res.body.data.count_questions, 2);
            assert.deepEqual(res.body.data.areas.map((area) => area.name).sort(), ['Lenguaje', 'Matemática']);
        });

        it('valida: cuerpo vacio, campos ajenos, preguntas invalidas', async () => {
            const list = await create({ name: 'Validar' });
            await call('patch', `/${list.id}`, user, {}).expect(422);
            await call('patch', `/${list.id}`, user, { user: 'otro' }).expect(422);
            await call('patch', `/${list.id}`, user, { questions: ['q1', 'q4'] }).expect(422);
            await call('patch', `/${list.id}`, user, { questions: ['q1', 'q1'] }).expect(422);
        });

        it('publicar exige al menos 10 preguntas; una vez publicada aparece en /practicas', async () => {
            const list = await create({ name: 'Para publicar', question_ids: ids(0, 9) });
            const refused = await call('patch', `/${list.id}`, user, { public: true }).expect(422);
            assert.equal(refused.body.error.details[0].field, 'public');

            const published = await call('patch', `/${list.id}`, user, { public: true, questions: ids(0, 10) }).expect(200);
            assert.equal(published.body.data.public, true);

            const catalog = await request(ctx.app).get(`${API}/practicas`).expect(200);
            assert.ok(catalog.body.data.some((practice) => practice.slug === published.body.data.slug));

            // Otro estudiante ya puede abrirla y resolverla.
            await request(ctx.app).get(`${API}/practicas/${published.body.data.slug}`).set(bearer(other)).expect(200);

            const hidden = await call('patch', `/${list.id}`, user, { public: false }).expect(200);
            assert.equal(hidden.body.data.public, false);
            await request(ctx.app).get(`${API}/practicas/${hidden.body.data.slug}`).set(bearer(other)).expect(404);
        });

        it('una lista publica no puede quedar con menos de 10 preguntas', async () => {
            const list = await create({ name: 'Publica corta', question_ids: ids(0, 10) });
            await call('patch', `/${list.id}`, user, { public: true }).expect(200);

            await call('patch', `/${list.id}`, user, { questions: ids(0, 5) }).expect(422);
            const res = await call('delete', `/${list.id}/preguntas/x0`, user).expect(422);
            assert.equal(res.body.error.details[0].field, 'public');
            assert.equal((await db('userquestionslists').findOne({ _id: list.id })).questions.length, 10);
        });
    });

    describe('agregar y quitar preguntas', () => {
        it('agrega una pregunta (201), recalcula y no admite duplicados', async () => {
            const list = await create({ name: 'Agregar' });
            const added = await call('post', `/${list.id}/preguntas`, user, { question_id: 'q1' }).expect(201);
            assert.equal(added.body.data.count_questions, 1);
            assert.deepEqual(added.body.data.areas, [{ name: 'Matemática', count: 1 }]);

            const duplicate = await call('post', `/${list.id}/preguntas`, user, { question_id: 'q1' }).expect(409);
            assert.equal(duplicate.body.error.code, 'CONFLICT');
        });

        it('rechaza preguntas que no se sirven', async () => {
            const list = await create({ name: 'Rechazar' });
            for (const id of ['q4', 'q5', 'q6', 'nada']) {
                await call('post', `/${list.id}/preguntas`, user, { question_id: id }).expect(422);
            }
        });

        it('dos altas simultaneas de la misma pregunta no la duplican', async () => {
            const list = await create({ name: 'Carrera' });
            await Promise.all([
                call('post', `/${list.id}/preguntas`, user, { question_id: 'q8' }),
                call('post', `/${list.id}/preguntas`, user, { question_id: 'q8' }),
            ]);
            assert.deepEqual((await db('userquestionslists').findOne({ _id: list.id })).questions, ['q8']);
        });

        it('quita una pregunta; si no esta en la lista -> 404', async () => {
            const list = await create({ name: 'Quitar', question_ids: ['q1', 'q7'] });
            const res = await call('delete', `/${list.id}/preguntas/q1`, user).expect(200);

            assert.equal(res.body.data.count_questions, 1);
            assert.deepEqual(res.body.data.areas, [{ name: 'Lenguaje', count: 1 }]);
            await call('delete', `/${list.id}/preguntas/q1`, user).expect(404);
        });
    });

    describe('limites', () => {
        it('plan gratuito: 30 preguntas por lista; la 31 -> 403 SUBSCRIPTION_REQUIRED', async () => {
            const free = await createUser(ctx);
            const list = await create({ name: 'Llena', question_ids: ids(0, 30) }, free);
            assert.equal(list.count_questions, 30);

            const res = await call('post', `/${list.id}/preguntas`, free, { question_id: 'x30' }).expect(403);
            assert.equal(res.body.error.code, 'SUBSCRIPTION_REQUIRED');
            await call('post', '', free, { name: 'Excede', question_ids: ids(0, 31) }).expect(403);
            await call('patch', `/${list.id}`, free, { questions: ids(0, 31) }).expect(403);
        });

        it('con suscripcion vigente: hasta 50; mas de 50 -> 422', async () => {
            const premium = await createUser(ctx);
            await ctx.User.updateOne({ _id: premium.session.user.id }, {
                $set: { suscription: { status: 'activo', end_date: new Date(Date.now() + 86_400_000) } },
            });
            const list = await create({ name: 'Grande', question_ids: ids(0, 40) }, premium);
            await call('post', `/${list.id}/preguntas`, premium, { question_id: 'q1' }).expect(201);
            assert.equal((await call('get', `/${list.id}`, premium).expect(200)).body.data.count_questions, 41);

            // 51 no cabe ni siquiera para quien paga (y ademas supera el maximo del esquema).
            await call('post', '', premium, { name: 'Enorme', question_ids: ['q1', ...ids(0, 50)] }).expect(422);
        });

        it('maximo 100 listas por usuario', async () => {
            const heavy = await createUser(ctx);
            await db('userquestionslists').insertMany(
                Array.from({ length: 100 }, (_, i) => ({ _id: `bulk-${heavy.session.user.id}-${i}`, user: heavy.session.user.id, name: `L${i}`, questions: [] })),
            );
            const res = await call('post', '', heavy, { name: 'La 101' }).expect(422);
            assert.match(res.body.error.details[0].message, /100 listas/);
        });
    });

    describe('DELETE /mis-listas/:id', () => {
        it('borra la lista (204) y despues no existe', async () => {
            const list = await create({ name: 'Efimera' });
            await call('delete', `/${list.id}`, user).expect(204);
            await call('get', `/${list.id}`, user).expect(404);
            await call('delete', `/${list.id}`, user).expect(404);
        });
    });

    it('las cuentas de docente tambien pueden tener listas', async () => {
        const teacher = await createUser(ctx, { account_type: 'Profesor' });
        const list = await create({ name: 'Material', question_ids: ['q1'] }, teacher);
        assert.equal(list.count_questions, 1);
    });
});
