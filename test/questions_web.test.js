import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

const SECRET = 'secreto-web-de-prueba-0123456789abcdef';
const WEB = { 'X-Edk-Client': 'web', 'X-Edk-Client-Secret': SECRET };
const options = { A: 'uno', B: 'dos', C: 'tres' };

// Detalle por URL y listado sin clave: lo que necesita /preguntas en Next.
describe('banco de preguntas: cliente web', () => {
    let ctx;
    let student;

    before(async () => {
        ctx = await bootTestApp({ WEB_CLIENT_SECRET: SECRET });
        await seedCatalog(ctx);
        student = await createUser(ctx);
        await ctx.mongoose.connection.db.collection('questions').insertMany([
            { _id: 'w1', uid: 'abc123', slug: 'matematica/abc123', area: 'Matemática', area_id: 'area-mat', verified: true, rpta: 'B', origin: 'Oficial', question: '<p>W1</p>', options, resolution: '<p>R</p>', source: 'UNMSM', created_at: new Date() },
            { _id: 'w2', uid: 'nokey1', slug: 'matematica/nokey1', area: 'Matemática', area_id: 'area-mat', verified: true, origin: 'Oficial', question: '<p>Sin clave</p>', options, created_at: new Date() },
            { _id: 'w3', slug: 'matematica-antigua-hash', area: 'Matemática', area_id: 'area-mat', verified: true, rpta: 'A', origin: 'Oficial', question: '<p>Antigua</p>', options, created_at: new Date() },
            { _id: 'w4', uid: 'priv01', slug: 'matematica/priv01', area: 'Matemática', area_id: 'area-mat', verified: true, rpta: 'A', origin: 'Docente', question: '<p>Privada</p>', options, created_at: new Date() },
        ]);
    });
    after(() => ctx.stop());

    const byPath = (path, headers = WEB) => request(ctx.app).get('/api/v1/preguntas/por-ruta').query({ path }).set(headers);

    it('por-ruta no existe para la app', async () => {
        await byPath('matematica/abc123', {}).expect(404);
    });

    it('resuelve area/uid sin exponer la clave a un visitante', async () => {
        const { data } = (await byPath('matematica/abc123').expect(200)).body;
        assert.equal(data.canonical, 'matematica/abc123');
        assert.equal(data.can_answer, true);
        assert.equal(data.question.source, 'UNMSM');
        assert.equal(data.my_answer, null);
        assert.ok(!JSON.stringify(data).includes('"correct"'));
    });

    it('slug de una pieza e _id llevan a la URL canonica', async () => {
        assert.equal((await byPath('w1').expect(200)).body.data.canonical, 'matematica/abc123');
        // Sin uid no hay canonica nueva: queda el slug.
        assert.equal((await byPath('matematica-antigua-hash').expect(200)).body.data.canonical, 'matematica-antigua-hash');
    });

    it('sirve la verificada sin clave pero no se puede responder', async () => {
        const { data } = (await byPath('matematica/nokey1').expect(200)).body;
        assert.equal(data.can_answer, false);
    });

    it('la pregunta privada de un docente es 404', async () => {
        await byPath('matematica/priv01').expect(404);
        await byPath('w4').expect(404);
    });

    it('tras responder devuelve la respuesta previa con la clave', async () => {
        await request(ctx.app).post('/api/v1/preguntas/w1/responder').set(bearer(student)).send({ selected: 'A' }).expect(200);
        const { data } = (await byPath('matematica/abc123', { ...WEB, ...bearer(student) }).expect(200)).body;
        assert.equal(data.my_answer.selected, 'A');
        assert.equal(data.my_answer.correct, 'B');
        assert.equal(data.my_answer.is_correct, false);
    });

    it('el listado web incluye las sin clave; el de la app no', async () => {
        const web = (await request(ctx.app).get('/api/v1/preguntas?limit=50').set(WEB).expect(200)).body.data.map((q) => q.id);
        const app = (await request(ctx.app).get('/api/v1/preguntas?limit=50').expect(200)).body.data.map((q) => q.id);
        assert.ok(web.includes('w2') && web.includes('q6'));
        assert.ok(!app.includes('w2') && !app.includes('q6'));
    });

    it('filtra por el nombre del area (enlaces indexados ?area=Matemática)', async () => {
        const res = await request(ctx.app).get('/api/v1/preguntas').query({ area: 'Matemática', limit: 50 }).set(WEB).expect(200);
        assert.ok(res.body.data.length > 0);
    });
});
