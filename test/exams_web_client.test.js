import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { seedCatalog, seedExams } from './helpers/seed.js';

const SECRET = 'secreto-web-de-prueba-0123456789abcdef';

// El servidor de Next (cliente web con su secreto) ve el detalle del examen sin sesion.
describe('examenes: detalle para el visitante web', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ EXAM_PREVIEW_QUESTIONS: '1', WEB_CLIENT_SECRET: SECRET });
        await seedCatalog(ctx);
        await seedExams(ctx);
    });
    after(() => ctx.stop());

    const get = (headers = {}) => request(ctx.app).get('/api/v1/examenes/unmsm-2025-i').set(headers);

    it('web valido sin token: vista previa, sin respuestas y con login_required', async () => {
        const { data } = (await get({ 'X-Edk-Client': 'web', 'X-Edk-Client-Secret': SECRET }).expect(200)).body;
        assert.deepEqual(data.items.map((item) => item.id), ['g1']);
        assert.equal(data.access.login_required, true);
        for (const item of data.items) {
            assert.equal('correct' in item, false);
            assert.equal('explanation' in item, false);
        }
    });

    it('app sin token: ninguna pregunta', async () => {
        const { data } = (await get().expect(200)).body;
        assert.deepEqual(data.items, []);
    });

    it('web con secreto erroneo: igual que la app', async () => {
        const { data } = (await get({ 'X-Edk-Client': 'web', 'X-Edk-Client-Secret': `${SECRET}x` }).expect(200)).body;
        assert.deepEqual(data.items, []);
    });
});
