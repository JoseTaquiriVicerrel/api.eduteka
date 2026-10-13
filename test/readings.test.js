import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

describe('lecturas', () => {
    let ctx;
    let student;
    let teacher;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        const { db } = ctx.mongoose.connection;
        const at = (days) => new Date(Date.now() - days * 86_400_000);
        const block = (id, extra) => ({
            _id: id, slug: id, type: 'reading_section', verified: true, origin: 'Oficial', title: `Lectura ${id}`,
            text: '<p>Texto</p>', questions: [], created_at: at(10), ...extra,
        });
        await db.collection('blocks').insertMany([
            block('lectura-mat-1', {
                area: 'MATEMÁTICA', title: 'Los números', created_at: at(1),
                text: `<p>El <b>álgebra</b> estudia ${'x'.repeat(300)}</p>`,
                // q4 no esta verificada y q5 es de docente: no se sirven.
                questions: ['q1', 'q4', 'q2', 'q5'],
                institution: { id: 'inst-unmsm', name: 'UNMSM', abrev: 'SM', image: '/images/inst/sm.png' },
                exam: { title: 'Examen UNMSM 2025-I' },
            }),
            block('lectura-mat-2', { area: 'Matemática', title: 'Geometría del río', questions: ['q3'], created_at: at(2) }),
            block('lectura-sin-area', { area: '', created_at: at(3) }),
            block('lectura-null', { area: null, created_at: at(4) }),
            block('de-docente', { area: 'Matemática', origin: 'Docente' }),
            block('sin-verificar', { area: 'Matemática', verified: false }),
            block('separador', { area: 'Matemática', type: 'divider_section' }),
        ]);
        student = await createUser(ctx);
        teacher = await createUser(ctx, { account_type: 'Profesor', teaching_area: 'area-mat' });
    });
    after(() => ctx.stop());

    const get = (path, user) => request(ctx.app).get(`/api/v1/lecturas${path}`).set(user ? bearer(user) : {});

    it('GET /lecturas: publico, solo oficiales y verificadas, la mas reciente primero', async () => {
        const res = await get('').expect(200);

        assert.deepEqual(res.body.data.map((item) => item.slug), ['lectura-mat-1', 'lectura-mat-2', 'lectura-sin-area', 'lectura-null']);
        assert.equal(res.body.meta.total, 4);

        const first = res.body.data[0];
        assert.equal(first.title, 'Los números');
        assert.equal(first.area, 'MATEMÁTICA');
        assert.equal(first.questions_count, 4);
        assert.equal(first.exam_title, 'Examen UNMSM 2025-I');
        assert.equal(first.institution.image, 'https://eduteka.test/images/inst/sm.png');
        // Extracto en texto plano y recortado.
        assert.ok(first.excerpt.startsWith('El álgebra estudia'));
        assert.ok(first.excerpt.endsWith('…') && first.excerpt.length <= 181);
        assert.ok(!JSON.stringify(res.body).includes('"text"'));
    });

    it('GET /lecturas/areas: junta las variantes de mayusculas con el nombre del catalogo y cuenta "Sin área"', async () => {
        const res = await get('/areas').expect(200);
        assert.deepEqual(res.body.data, [
            { slug: 'matematica', name: 'Matemática', count: 2 },
            { slug: 'sin-area', name: 'Sin área', count: 2 },
        ]);
    });

    it('filtra por area (slug o nombre), por texto y valida', async () => {
        assert.deepEqual((await get('?area=matematica').expect(200)).body.data.map((item) => item.slug), ['lectura-mat-1', 'lectura-mat-2']);
        assert.deepEqual((await get('?area=Matemática').expect(200)).body.meta.total, 2);
        assert.deepEqual((await get('?area=sin-area').expect(200)).body.data.map((item) => item.slug), ['lectura-sin-area', 'lectura-null']);
        assert.equal((await get('?area=otra').expect(200)).body.meta.total, 0);
        assert.deepEqual((await get('?q=río').expect(200)).body.data.map((item) => item.slug), ['lectura-mat-2']);
        assert.deepEqual((await get('?q=ÁLGEBRA').expect(200)).body.data.map((item) => item.slug), ['lectura-mat-1']);
        assert.equal((await get('?q=(').expect(200)).body.meta.total, 0);
        await get('?limit=51').expect(422);
        await get('?x=1').expect(422);
    });

    it('GET /lecturas/:slug: el texto y sus preguntas verificadas en orden, sin respuestas para el estudiante', async () => {
        const res = await get('/lectura-mat-1', student).expect(200);
        const { data } = res.body;

        assert.equal(data.title, 'Los números');
        assert.equal(data.items[0].kind, 'reading');
        assert.ok(data.items[0].text.includes('<b>álgebra</b>'));
        const questions = data.items.slice(1);
        assert.deepEqual(questions.map((item) => [item.kind, item.id, item.n]), [['question', 'q1', 1], ['question', 'q2', 2]]);
        assert.ok(questions[0].question.includes('https://eduteka.test/images/questions/q1.png'));
        assert.equal(questions[0].options.length > 0, true);
        assert.ok(!('correct' in questions[0]) && !('explanation' in questions[0]));
        assert.ok(!JSON.stringify(data).includes('"rpta"'));
    });

    it('el docente recibe la clave y la resolucion, como en la web', async () => {
        const { data } = (await get('/lectura-mat-1', teacher).expect(200)).body;
        const [q1] = data.items.slice(1);
        assert.equal(q1.correct, 'B');
        assert.ok(q1.explanation.includes('Porque sí'));
    });

    it('no sirve lecturas de docente, sin verificar, separadores ni inexistentes', async () => {
        for (const slug of ['de-docente', 'sin-verificar', 'separador', 'no-existe']) {
            await get(`/${slug}`).expect(404);
        }
    });
});
