import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedExams } from './helpers/seed.js';

const API = '/api/v1';
const ANSWER_KEYS = ['"rpta"', '"resolution"', '"correct"', '"explanation"', '"options_answers"'];

describe('examenes', () => {
    let ctx;
    let student;
    let teacher;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        await seedExams(ctx);
        [student, teacher] = [await createUser(ctx), await createUser(ctx, { account_type: 'Profesor' })];
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const get = (path, user) => request(ctx.app).get(`${API}/examenes${path}`).set(user ? bearer(user) : {});
    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const assertNoAnswers = (body) => {
        const json = JSON.stringify(body);
        for (const key of ANSWER_KEYS) assert.ok(!json.includes(key), `expone ${key}`);
    };

    describe('GET /examenes', () => {
        it('es publico y lista solo los verificados, el mas reciente primero', async () => {
            const res = await get('').expect(200);

            assert.deepEqual(res.body.data.map((exam) => exam.slug), ['unmsm-2025-i', 'unmsm-2024-ii', 'antigua-2023']);
            assert.deepEqual(res.body.meta, { page: 1, limit: 20, total: 3, has_more: false });
        });

        it('serializa con lista blanca: imagen absoluta, PDF solo como indicador (nunca la ruta)', async () => {
            const res = await get('').expect(200);
            const e1 = res.body.data.find((exam) => exam.id === 'e1');

            assert.deepEqual(e1, {
                id: 'e1', title: 'Examen UNMSM 2025-I', description: 'Primera fase', slug: 'unmsm-2025-i', modality: 'Ordinario',
                date: '2025-03-10T00:00:00.000Z', image: 'https://eduteka.test/images/posts/e1.png',
                institution: { id: 'inst-unmsm', name: 'UNMSM', abrev: 'SM', image: 'https://eduteka.test/images/inst/sm.png' },
                subjects: ['Matemática', 'Lenguaje'], favorites: 0, has_pdf: true, created_at: e1.created_at,
            });
            assert.equal(res.body.data.find((exam) => exam.id === 'e2').has_pdf, false);
            const json = JSON.stringify(res.body);
            assert.ok(!json.includes('/private/'), 'expone la ruta del PDF');
            assertNoAnswers(res.body);
        });

        it('filtra por institucion, modalidad y año', async () => {
            const institution = await get('?institution=inst-antigua').expect(200);
            assert.deepEqual(institution.body.data.map((e) => e.slug), ['antigua-2023']);

            const modality = await get('?modality=Extraordinario').expect(200);
            assert.deepEqual(modality.body.data.map((e) => e.slug), ['unmsm-2024-ii']);

            const year = await get('?year=2025').expect(200);
            assert.deepEqual(year.body.data.map((e) => e.slug), ['unmsm-2025-i']);
            assert.equal((await get('?year=1999').expect(200)).body.meta.total, 0);
        });

        it('filtra por area del catalogo aunque la materia del examen tenga otras mayusculas', async () => {
            const math = await get('?area=matematica').expect(200);
            assert.deepEqual(math.body.data.map((e) => e.slug), ['unmsm-2025-i']);

            // e1 dice "Lenguaje" y e2 "LENGUAJE".
            const language = await get('?area=lenguaje').expect(200);
            assert.deepEqual(language.body.data.map((e) => e.slug).sort(), ['unmsm-2024-ii', 'unmsm-2025-i']);

            await get('?area=no-existe').expect(404);
        });

        it('busca por titulo con texto literal (no como expresion regular)', async () => {
            const found = await get('?q=unmsm').expect(200);
            assert.deepEqual(found.body.data.map((e) => e.slug), ['unmsm-2025-i', 'unmsm-2024-ii']);

            assert.equal((await get('?q=(2025').expect(200)).body.meta.total, 0);
            assert.equal((await get('?q=.*').expect(200)).body.meta.total, 0);
            await get('?q[$ne]=x').expect(422);
        });

        it('pagina y valida', async () => {
            const page = await get('?limit=2&page=2').expect(200);
            assert.deepEqual(page.body.data.map((e) => e.slug), ['antigua-2023']);
            assert.deepEqual(page.body.meta, { page: 2, limit: 2, total: 3, has_more: false });

            await get('?limit=51').expect(422);
            await get('?year=abc').expect(422);
            await get('?year=1800').expect(422);
            await get('?desconocido=1').expect(422);
        });
    });

    describe('GET /examenes/:slug', () => {
        it('es publico: cuadernillos, archivos y el primer cuadernillo en su orden, sin respuestas', async () => {
            const res = await get('/unmsm-2025-i').expect(200);
            const { data } = res.body;

            assert.equal(data.title, 'Examen UNMSM 2025-I');
            assert.equal(data.area, 'A');
            assert.equal(data.favorite, false);
            assert.deepEqual(data.areas, [
                { code: 'A', abrev: 'A', title: 'Área A', description: 'A: Ingenierías', solution: true, verified: true },
                { code: 'B', abrev: 'B', title: 'Área B', description: 'B: Biomédicas', solution: false, verified: false },
            ]);
            // Solo el cuadernillo con ruta; la ruta no sale.
            assert.deepEqual(data.files, [{ area: 'A', title: 'Cuadernillo A' }]);
            assert.deepEqual(data.access, { preview: false, total_questions: 2, served_questions: 2 });

            // g1, la lectura gr1 y g2; el conflicto (gx) y el id que ya no existe (gmissing) se omiten.
            assert.deepEqual(data.items.map((item) => [item.kind, item.id, item.n]), [
                ['question', 'g1', 1], ['reading', 'gr1', undefined], ['question', 'g2', 2],
            ]);
            assert.match(data.items[0].question, /src="https:\/\/eduteka\.test\/images\/questions\/g1\.png"/);
            assert.deepEqual(data.items[0].options.map((option) => option.key), ['A', 'B', 'C']);
            assert.equal(data.items[1].title, 'Lectura 1');
            assert.match(data.items[1].text, /src="https:\/\/eduteka\.test\/images\/blocks\/r\.png"/);
            assert.equal(data.items[2].area, 'Lenguaje');

            assertNoAnswers(res.body);
            assert.ok(!JSON.stringify(res.body).includes('/private/'));
        });

        it('?area= elige el cuadernillo; uno inexistente -> 404', async () => {
            const b = await get('/unmsm-2025-i?area=B').expect(200);
            assert.equal(b.body.data.area, 'B');
            assert.deepEqual(b.body.data.items.map((item) => item.id), ['g2', 'g3']);
            assert.deepEqual(b.body.data.items.map((item) => item.n), [1, 2]);

            await get('/unmsm-2025-i?area=Z').expect(404);
            await get('/unmsm-2025-i?area=').expect(422);
            await get('/unmsm-2025-i?foo=1').expect(422);
        });

        it('un examen antiguo sin banco general sirve las preguntas del propio cuadernillo', async () => {
            const res = await get('/unmsm-2024-ii').expect(200);
            assert.equal(res.body.data.unique, true);
            assert.equal(res.body.data.favorites, 3);
            assert.deepEqual(res.body.data.items.map((item) => item.id), ['l1', 'l2']);
            assertNoAnswers(res.body);
        });

        it('no sirve borradores, examenes sin contenido ni slugs inexistentes (404)', async () => {
            for (const slug of ['borrador', 'antigua-2023', 'no-existe']) {
                const res = await get(`/${slug}`).expect(404);
                assert.equal(res.body.error.code, 'NOT_FOUND');
            }
        });

        it('los estudiantes no reciben la respuesta; los docentes y administradores si, como material', async () => {
            const asStudent = await get('/unmsm-2025-i', student).expect(200);
            assertNoAnswers(asStudent.body);

            const asTeacher = await get('/unmsm-2025-i', teacher).expect(200);
            const first = asTeacher.body.data.items[0];
            assert.equal(first.correct, 'B');
            assert.match(first.explanation, /Explicación g1/);
            // La lectura no lleva respuesta.
            assert.equal(asTeacher.body.data.items[1].correct, undefined);

            const admin = await createUser(ctx);
            await ctx.User.updateOne({ _id: admin.session.user.id }, { $set: { rol: 'Administrador' } });
            assert.equal((await get('/unmsm-2025-i', admin).expect(200)).body.data.items[0].correct, 'B');
        });

        it('un token invalido no rompe la lectura publica (se trata como anonimo)', async () => {
            const res = await request(ctx.app).get(`${API}/examenes/unmsm-2025-i`).set('Authorization', 'Bearer basura').expect(200);
            assertNoAnswers(res.body);
        });
    });

    describe('POST /examenes/:id/favorito y GET /examenes/favoritos', () => {
        const favorite = (id, user, body = {}) => request(ctx.app).post(`${API}/examenes/${id}/favorito`).set(user ? bearer(user) : {}).send(body);

        it('exige sesion', async () => {
            await favorite('e1', null).expect(401);
            await get('/favoritos').expect(401);
        });

        it('sin cuerpo alterna; devuelve el estado y el total', async () => {
            const user = await createUser(ctx);
            const on = await favorite('e1', user).expect(200);
            assert.deepEqual(on.body.data, { favorite: true, favorites: 1 });
            assert.equal((await db('exams').findOne({ _id: 'e1' })).favorites, 1);

            ctx.kv.flushMemory();
            const off = await favorite('e1', user).expect(200);
            assert.deepEqual(off.body.data, { favorite: false, favorites: 0 });
            assert.equal((await db('exams').findOne({ _id: 'e1' })).favorites, 0);
        });

        it('con { favorite } fija el estado: reenviar la misma peticion no lo invierte', async () => {
            const user = await createUser(ctx);
            await favorite('e2', user, { favorite: true }).expect(200);
            ctx.kv.flushMemory();
            const again = await favorite('e2', user, { favorite: true }).expect(200);

            assert.equal(again.body.data.favorite, true);
            assert.equal(await db('favoriteexams').countDocuments({ user_id: user.session.user.id, exam_id: 'e2' }), 1);
            ctx.kv.flushMemory();
            const off = await favorite('e2', user, { favorite: false }).expect(200);
            assert.equal(off.body.data.favorite, false);
        });

        it('el contador cuenta usuarios distintos', async () => {
            const [one, two] = [await createUser(ctx), await createUser(ctx)];
            await favorite('e4', one, { favorite: true }).expect(200);
            const res = await favorite('e4', two, { favorite: true }).expect(200);
            assert.equal(res.body.data.favorites, 2);
        });

        it('doble toque: la segunda peticion se rechaza (409) y no duplica el favorito', async () => {
            const user = await createUser(ctx);
            const results = await Promise.all([favorite('e1', user, { favorite: true }), favorite('e1', user, { favorite: true })]);
            assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
            assert.equal(await db('favoriteexams').countDocuments({ user_id: user.session.user.id, exam_id: 'e1' }), 1);
        });

        it('un examen no publicado o inexistente -> 404', async () => {
            const user = await createUser(ctx);
            await favorite('e3', user).expect(404);
            await favorite('nada', user).expect(404);
        });

        it('valida el cuerpo', async () => {
            const user = await createUser(ctx);
            await favorite('e1', user, { favorite: 'si' }).expect(422);
            await favorite('e1', user, { otro: 1 }).expect(422);
        });

        it('/favoritos lista los del usuario, el ultimo marcado primero, sin los desmarcados ni los no publicados', async () => {
            const user = await createUser(ctx);
            const id = user.session.user.id;
            await db('favoriteexams').insertMany([
                { _id: `${id}-1`, user_id: id, exam_id: 'e1', state: true, updated_at: new Date(Date.UTC(2026, 0, 1)) },
                { _id: `${id}-2`, user_id: id, exam_id: 'e2', state: true, updated_at: new Date(Date.UTC(2026, 0, 3)) },
                { _id: `${id}-3`, user_id: id, exam_id: 'e4', state: false, updated_at: new Date(Date.UTC(2026, 0, 4)) },
                { _id: `${id}-4`, user_id: id, exam_id: 'e3', state: true, updated_at: new Date(Date.UTC(2026, 0, 5)) },
                { _id: 'ajeno', user_id: 'otro', exam_id: 'e4', state: true, updated_at: new Date() },
            ]);

            const res = await get('/favoritos', user).expect(200);
            assert.deepEqual(res.body.data.map((exam) => exam.slug), ['unmsm-2024-ii', 'unmsm-2025-i']);
            assert.equal(res.body.data[0].favorited_at, '2026-01-03T00:00:00.000Z');
            assert.ok(!JSON.stringify(res.body).includes('/private/'));
            assert.equal(res.body.meta.total, 3); // los publicados y no, marcados (el no publicado no se muestra)

            const detail = await get('/unmsm-2025-i', user).expect(200);
            assert.equal(detail.body.data.favorite, true);
            assert.equal((await get('/unmsm-2024-ii', user).expect(200)).body.data.favorite, true);
            assert.equal((await get('/antigua-2023', user)).status, 404);
        });

        it('/favoritos no se confunde con un slug y valida la paginacion', async () => {
            const user = await createUser(ctx);
            const res = await get('/favoritos', user).expect(200);
            assert.deepEqual(res.body.data, []);
            await get('/favoritos?limit=51', user).expect(422);
        });

        it('las cuentas de docente tambien pueden marcar favoritos', async () => {
            const res = await favorite('e1', teacher, { favorite: true }).expect(200);
            assert.equal(res.body.data.favorite, true);
        });
    });
});
