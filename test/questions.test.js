import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

const FORBIDDEN_KEYS = ['"rpta"', '"resolution"', '"options_answers"', '"total_answers"', '"rpta_text"'];

describe('banco de preguntas', () => {
    let ctx;
    let student;
    let teacher;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        student = await createUser(ctx);
        teacher = await createUser(ctx, { account_type: 'Profesor' });
    });
    after(() => ctx.stop());
    // El bloqueo anti doble-toque dura 2 s: cada prueba empieza limpia.
    beforeEach(() => ctx.kv.flushMemory());

    const get = (path, headers = {}) => request(ctx.app).get(`/api/v1/preguntas${path}`).set(headers);
    const answer = (id, selected, user = student) =>
        request(ctx.app).post(`/api/v1/preguntas/${id}/responder`).set(bearer(user)).send({ selected });
    const questionDoc = (id) => ctx.mongoose.connection.db.collection('questions').findOne({ _id: id });

    const assertNoSecrets = (body) => {
        const json = JSON.stringify(body);
        for (const key of FORBIDDEN_KEYS) assert.ok(!json.includes(key), `la respuesta expone ${key}`);
    };

    describe('GET /preguntas', () => {
        it('lista las practicables, la mas reciente primero, sin respuesta ni explicacion', async () => {
            const res = await get('').expect(200);

            // q1,q2,q3,q7,q8 (q4 sin verificar, q5 de docente, q6 sin clave quedan fuera).
            assert.deepEqual(res.body.data.map((question) => question.id), ['q8', 'q1', 'q2', 'q3', 'q7']);
            assert.deepEqual(res.body.meta, { page: 1, limit: 20, total: 5, has_more: false });
            assertNoSecrets(res.body);
        });

        it('cada pregunta lleva opciones ordenadas, imagenes absolutas y la lectura compartida', async () => {
            const res = await get('').expect(200);
            const q1 = res.body.data.find((question) => question.id === 'q1');
            const q3 = res.body.data.find((question) => question.id === 'q3');

            assert.deepEqual(q1.options.map((option) => option.key), ['A', 'B', 'C', 'D', 'E']);
            assert.equal(q1.options[0].text, 'uno');
            assert.match(q1.question, /src="https:\/\/eduteka\.test\/images\/questions\/q1\.png"/);
            assert.equal(q1.context, null);
            assert.equal(q1.topic, 'Álgebra');
            assert.equal(q1.difficulty, 'Fácil');

            assert.equal(q3.context.id, 'b1');
            assert.match(q3.context.text, /src="https:\/\/eduteka\.test\/images\/blocks\/b1\.png"/);
        });

        it('filtra por area (id o slug), tema, dificultad e institucion', async () => {
            const byId = await get('?area=area-mat').expect(200);
            const bySlug = await get('?area=matematica').expect(200);
            assert.deepEqual(byId.body.data.map((q) => q.id), bySlug.body.data.map((q) => q.id));
            assert.equal(byId.body.meta.total, 4);

            const topic = await get('?area=matematica&topic=%C3%81lgebra').expect(200);
            assert.deepEqual(topic.body.data.map((q) => q.id), ['q1', 'q2']);

            const difficulty = await get('?difficulty=F%C3%A1cil').expect(200);
            assert.deepEqual(difficulty.body.data.map((q) => q.id).sort(), ['q1', 'q3', 'q7']);

            const institution = await get('?institution=inst-unmsm').expect(200);
            assert.deepEqual(institution.body.data.map((q) => q.id), ['q1']);
        });

        it('un area inexistente -> 404', async () => {
            const res = await get('?area=no-existe').expect(404);
            assert.equal(res.body.error.code, 'NOT_FOUND');
        });

        it('pagina con meta.has_more y orden estable', async () => {
            const first = await get('?limit=2&page=1').expect(200);
            const second = await get('?limit=2&page=2').expect(200);
            const third = await get('?limit=2&page=3').expect(200);

            assert.deepEqual(first.body.data.map((q) => q.id), ['q8', 'q1']);
            assert.deepEqual(second.body.data.map((q) => q.id), ['q2', 'q3']);
            assert.deepEqual(third.body.data.map((q) => q.id), ['q7']);
            assert.deepEqual(first.body.meta, { page: 1, limit: 2, total: 5, has_more: true });
            assert.equal(third.body.meta.has_more, false);

            const beyond = await get('?limit=2&page=9').expect(200);
            assert.deepEqual(beyond.body.data, []);
            assert.equal(beyond.body.meta.total, 5);
        });

        it('valida page y limit (maximo 50)', async () => {
            await get('?limit=51').expect(422);
            await get('?limit=0').expect(422);
            await get('?page=0').expect(422);
            await get('?page=abc').expect(422);
            await get('?desconocido=1').expect(422);
        });

        it('busca por texto y ordena por relevancia', async () => {
            const res = await get('?q=Geometr%C3%ADa').expect(200);
            assert.deepEqual(res.body.data.map((q) => q.id), ['q3']);
            assertNoSecrets(res.body);
        });

        it('un texto de busqueda vacio o solo espacios se ignora; los operadores de Mongo no se cuelan', async () => {
            const blank = await get('?q=%20%20').expect(200);
            assert.equal(blank.body.meta.total, 5);

            // ?q[$ne]=x llega como objeto y se rechaza por tipo.
            await get('?q[$ne]=x').expect(422);
            await get('?q=a&q=b').expect(422);
        });
    });

    describe('GET /preguntas/temas', () => {
        it('temas del area con el numero de preguntas practicables', async () => {
            const res = await get('/temas?area=matematica').expect(200);
            assert.deepEqual(res.body.data, [
                { topic: 'Álgebra', count: 2 },
                { topic: 'Aritmética', count: 1 },
                { topic: 'Geometría', count: 1 },
            ]);
        });

        it('el area es obligatoria (422) y debe existir (404)', async () => {
            await get('/temas').expect(422);
            await get('/temas?area=no-existe').expect(404);
        });

        it('/temas no se confunde con /:id', async () => {
            const res = await get('/temas?area=lenguaje').expect(200);
            assert.deepEqual(res.body.data, [{ topic: 'Sinónimos', count: 1 }]);
        });
    });

    describe('GET /preguntas/:id', () => {
        it('devuelve la pregunta sin respuesta', async () => {
            const res = await get('/q1').expect(200);
            assert.equal(res.body.data.id, 'q1');
            assertNoSecrets(res.body);
        });

        it('no sirve preguntas sin verificar, de docente, sin clave o inexistentes (404)', async () => {
            for (const id of ['q4', 'q5', 'q6', 'nada']) {
                const res = await get(`/${id}`).expect(404);
                assert.equal(res.body.error.code, 'NOT_FOUND');
            }
        });
    });

    describe('POST /preguntas/:id/responder', () => {
        it('exige sesion (401) y una cuenta que practique (403 para docentes)', async () => {
            await request(ctx.app).post('/api/v1/preguntas/q1/responder').send({ selected: 'A' }).expect(401);
            const res = await answer('q1', 'A', teacher).expect(403);
            assert.equal(res.body.error.code, 'FORBIDDEN');
        });

        it('respuesta correcta: corrige, explica y suma un voto a la comunidad', async () => {
            const res = await answer('q1', 'B').expect(200);
            const { data } = res.body;

            assert.equal(data.question_id, 'q1');
            assert.equal(data.selected, 'B');
            assert.equal(data.is_correct, true);
            assert.equal(data.correct, 'B');
            assert.match(data.explanation, /src="https:\/\/eduteka\.test\/images\/questions\/r1\.png"/);
            assert.equal(data.community.total, 1);
            assert.deepEqual(data.community.options.find((option) => option.key === 'B'), { key: 'B', count: 1, percent: 100 });
        });

        it('respuesta incorrecta; acepta minusculas', async () => {
            const res = await answer('q2', 'b').expect(200);
            assert.equal(res.body.data.selected, 'B');
            assert.equal(res.body.data.is_correct, false);
            assert.equal(res.body.data.correct, 'A');
            assert.equal(res.body.data.explanation, null);
        });

        it('inicializa los contadores de una pregunta que nadie habia respondido (q2)', async () => {
            const doc = await questionDoc('q2');
            assert.equal(doc.total_answers, 1);
            assert.equal(doc.options_answers.B, 1);
            assert.equal(doc.options_answers.A, 0);
        });

        it('responder lo mismo otra vez no altera los contadores', async () => {
            await answer('q3', 'C').expect(200);
            ctx.kv.flushMemory();
            const again = await answer('q3', 'C').expect(200);

            assert.equal(again.body.data.community.total, 1);
            assert.equal((await questionDoc('q3')).total_answers, 1);
            assert.equal(await ctx.mongoose.connection.db.collection('useranswers').countDocuments({ user_id: student.session.user.id, question_id: 'q3' }), 1);
        });

        it('cambiar de opcion MUEVE el voto: el total no cambia', async () => {
            await answer('q7', 'A').expect(200);
            ctx.kv.flushMemory();
            const res = await answer('q7', 'D').expect(200);

            assert.equal(res.body.data.is_correct, true);
            assert.equal(res.body.data.community.total, 1);
            const byKey = Object.fromEntries(res.body.data.community.options.map((option) => [option.key, option.count]));
            assert.equal(byKey.A, 0);
            assert.equal(byKey.D, 1);
        });

        it('suma a los votos previos y calcula porcentajes (q8: A=2,B=2 + un voto nuevo)', async () => {
            const other = await createUser(ctx);
            const res = await answer('q8', 'A', other).expect(200);

            assert.equal(res.body.data.community.total, 5);
            const a = res.body.data.community.options.find((option) => option.key === 'A');
            assert.deepEqual(a, { key: 'A', count: 3, percent: 60 });
        });

        it('varios usuarios: cada uno cuenta una vez', async () => {
            const [one, two] = await Promise.all([createUser(ctx), createUser(ctx)]);
            await Promise.all([answer('q1', 'A', one).expect(200), answer('q1', 'C', two).expect(200)]);

            const doc = await questionDoc('q1');
            assert.equal(doc.total_answers, 3); // el estudiante de antes + estos dos
            assert.equal(doc.options_answers.A, 1);
            assert.equal(doc.options_answers.B, 1);
            assert.equal(doc.options_answers.C, 1);
        });

        it('doble toque: la segunda peticion identica se rechaza (409) y el voto cuenta una sola vez', async () => {
            const user = await createUser(ctx);
            const before = (await questionDoc('q2')).total_answers;

            const results = await Promise.all([answer('q2', 'C', user), answer('q2', 'C', user)]);
            assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
            assert.equal((await questionDoc('q2')).total_answers, before + 1);
        });

        it('alternativa que no existe en la pregunta -> 422; pregunta no servible -> 404', async () => {
            const invalid = await answer('q1', 'Z').expect(422);
            assert.equal(invalid.body.error.details[0].field, 'selected');

            await answer('q4', 'A').expect(404);
            await answer('q5', 'A').expect(404);
            await answer('q6', 'A').expect(404);
            await answer('nada', 'A').expect(404);
        });

        it('valida el cuerpo', async () => {
            const bad = await request(ctx.app).post('/api/v1/preguntas/q1/responder').set(bearer(student)).send({}).expect(422);
            assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
            await request(ctx.app).post('/api/v1/preguntas/q1/responder').set(bearer(student)).send({ selected: 'A', extra: 1 }).expect(422);
            await request(ctx.app).post('/api/v1/preguntas/q1/responder').set(bearer(student)).send({ selected: '$ne' }).expect(422);
        });

        it('no toca updated_at de la pregunta (los contadores no son una edicion)', async () => {
            const doc = await questionDoc('q8');
            assert.equal(doc.updated_at, undefined);
        });
    });

    describe('POST /preguntas/:id/reportar', () => {
        const report = (id, body, user = student) =>
            request(ctx.app).post(`/api/v1/preguntas/${id}/reportar`).set(bearer(user)).send(body);

        it('exige sesion', async () => {
            await request(ctx.app).post('/api/v1/preguntas/q1/reportar').send({ type: 'Pregunta', description: 'x' }).expect(401);
        });

        it('crea el reporte en estado Pendiente; cualquier tipo de cuenta puede reportar', async () => {
            const res = await report('q1', { type: 'Pregunta', description: '  Falta una imagen  ' }).expect(201);
            assert.equal(res.body.data.status, 'Pendiente');

            const saved = await ctx.mongoose.connection.db.collection('questionreports').findOne({ _id: res.body.data.id });
            assert.equal(saved.description, 'Falta una imagen');
            assert.equal(saved.user_id, student.session.user.id);

            await report('q1', { type: 'Respuesta', description: 'La clave parece mal' }, teacher).expect(201);
        });

        it('el mismo tipo sobre la misma pregunta no se repite (409); otro tipo si', async () => {
            await report('q2', { type: 'Opción', description: 'Opcion C duplicada' }).expect(201);
            const duplicate = await report('q2', { type: 'Opción', description: 'Otra vez' }).expect(409);
            assert.equal(duplicate.body.error.code, 'CONFLICT');
            await report('q2', { type: 'Pregunta', description: 'Enunciado confuso' }).expect(201);
        });

        it('valida tipo y descripcion', async () => {
            await report('q3', { type: 'Otro', description: 'x' }).expect(422);
            await report('q3', { type: 'Pregunta', description: '   ' }).expect(422);
            await report('q3', { type: 'Pregunta', description: 'x'.repeat(501) }).expect(422);
            await report('q3', { type: 'Pregunta' }).expect(422);
        });

        it('una pregunta que no se sirve -> 404', async () => {
            await report('q4', { type: 'Pregunta', description: 'x' }).expect(404);
            await report('nada', { type: 'Pregunta', description: 'x' }).expect(404);
        });
    });
});
