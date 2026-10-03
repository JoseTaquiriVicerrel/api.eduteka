import './helpers/env.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { buildListPdf, htmlToText } from '#Libs/list_pdf.js';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

describe('htmlToText', () => {
    it('quita etiquetas conservando los saltos de linea y decodifica entidades', () => {
        assert.equal(htmlToText('<p>Hola&nbsp;mundo</p><p>L&iacute;nea &amp; dos</p>'), 'Hola mundo\nLínea & dos');
        assert.equal(htmlToText('uno<br>dos<br/>tres'), 'uno\ndos\ntres');
        assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
        assert.equal(htmlToText('5 &lt; 7 &#38; &#x41;'), '5 < 7 & A');
    });

    it('sustituye las imagenes por una marca y tolera valores que no son texto', () => {
        assert.equal(htmlToText('Mira <img src="/images/a.png" alt="x"> esto'), 'Mira [imagen] esto');
        assert.equal(htmlToText(null), '');
        assert.equal(htmlToText(undefined), '');
    });

    it('no ejecuta ni interpreta etiquetas peligrosas: solo las elimina', () => {
        assert.equal(htmlToText('<script>alert(1)</script>Hola'), 'alert(1)Hola');
    });
});

describe('buildListPdf', () => {
    const question = (index, extra = {}) => ({
        question: `<p>Pregunta número ${index} con texto suficiente para ocupar espacio en la página.</p>`,
        options: [{ key: 'A', text: 'uno' }, { key: 'B', text: 'dos' }, { key: 'C', text: 'tres' }],
        correct: 'B',
        ...extra,
    });

    it('genera un PDF valido con el titulo en sus metadatos', async () => {
        const buffer = await buildListPdf({ title: 'Mi lista', description: '<p>Para repasar</p>', questions: [question(1)] });

        assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
        const doc = await PDFDocument.load(buffer);
        assert.equal(doc.getTitle(), 'Mi lista');
        assert.equal(doc.getPageCount(), 1);
    });

    it('pagina cuando hay muchas preguntas', async () => {
        const buffer = await buildListPdf({ title: 'Larga', questions: Array.from({ length: 60 }, (_, i) => question(i + 1)) });
        assert.ok((await PDFDocument.load(buffer)).getPageCount() >= 3);
    });

    it('no revienta con simbolos que la fuente estandar no tiene ni con palabras enormes', async () => {
        const buffer = await buildListPdf({
            title: 'Símbolos ≤ ≥ √ π Ω → 日本',
            questions: [question(1, { question: '<p>Si x ≤ 3 y √x ≥ π entonces \\frac{a}{b} → ∞ ' + 'a'.repeat(300) + '</p>' })],
        });
        assert.ok((await PDFDocument.load(buffer)).getPageCount() >= 1);
    });

    it('la clave de respuestas solo aparece si se pide (el PDF crece)', async () => {
        const questions = Array.from({ length: 5 }, (_, i) => question(i + 1));
        const without = await buildListPdf({ title: 'Clave', questions });
        const withKey = await buildListPdf({ title: 'Clave', questions, includeAnswers: true });
        assert.ok(withKey.length > without.length);
    });
});

describe('GET /mis-listas/:id/pdf', () => {
    let ctx;
    let user;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        user = await createUser(ctx);
        await ctx.mongoose.connection.db.collection('questions').insertOne({
            _id: 'math', area: 'Matemática', area_id: 'area-mat', verified: true, rpta: 'A',
            question: '<p>Si x ≤ 3 entonces √x &lt; π</p>', options: { A: 'a', B: 'b' },
        });
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const create = async (body, owner = user) => (await request(ctx.app).post('/api/v1/mis-listas').set(bearer(owner)).send(body).expect(201)).body.data;
    const pdf = (id, who = user, query = '') => request(ctx.app).get(`/api/v1/mis-listas/${id}/pdf${query}`).set(who ? bearer(who) : {}).buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
            const body = Buffer.concat(chunks);
            cb(null, String(res.headers['content-type']).includes('json') ? JSON.parse(body.toString('utf8')) : body);
        });
    });

    it('exige sesion; una lista ajena o inexistente es 404', async () => {
        const list = await create({ name: 'Mía', question_ids: ['q1'] });
        await pdf(list.id, null).expect(401);
        const other = await createUser(ctx);
        await pdf(list.id, other).expect(404);
        await pdf('no-existe').expect(404);
    });

    it('descarga un PDF adjunto con el nombre de la lista', async () => {
        const list = await create({ name: 'Mis repasos', description: 'Para el viernes', question_ids: ['q1', 'q2', 'math'] });
        const res = await pdf(list.id).expect(200);

        assert.equal(res.headers['content-type'], 'application/pdf');
        assert.match(res.headers['content-disposition'], /^attachment; filename="mis-repasos\.pdf"/);
        assert.equal(Number(res.headers['content-length']), res.body.length);
        const doc = await PDFDocument.load(res.body);
        assert.equal(doc.getTitle(), 'Mis repasos');
        assert.ok(doc.getPageCount() >= 1);
    });

    it('una lista vacia, o cuyas preguntas ya no se sirven, es 409', async () => {
        const empty = await create({ name: 'Vacía' });
        const res = await pdf(empty.id).expect(409);
        assert.match(res.body.error.message, /no tiene preguntas/);

        await ctx.mongoose.connection.db.collection('userquestionslists').insertOne({
            _id: 'rota', user: user.session.user.id, name: 'Rota', questions: ['q4', 'q5', 'nada'],
        });
        await pdf('rota').expect(409);
    });

    it('la clave de respuestas exige suscripcion (o cuenta de docente)', async () => {
        const list = await create({ name: 'Con clave', question_ids: ['q1', 'q2', 'q3'] });
        const refused = await pdf(list.id, user, '?include_answers=true').expect(403);
        assert.equal(refused.body.error.code, 'SUBSCRIPTION_REQUIRED');
        await pdf(list.id, user, '?include_answers=quizas').expect(422);

        const subscriber = await createUser(ctx);
        await ctx.User.updateOne({ _id: subscriber.session.user.id }, { $set: { suscription: { status: 'activo', end_date: new Date(Date.now() + 86_400_000) } } });
        const own = await create({ name: 'Con clave', question_ids: ['q1', 'q2', 'q3'] }, subscriber);
        const plain = await pdf(own.id, subscriber).expect(200);
        const keyed = await pdf(own.id, subscriber, '?include_answers=true').expect(200);
        assert.ok(keyed.body.length > plain.body.length);

        const teacher = await createUser(ctx, { account_type: 'Profesor' });
        const teachersList = await create({ name: 'Material', question_ids: ['q1'] }, teacher);
        await pdf(teachersList.id, teacher, '?include_answers=true').expect(200);
    });
});
