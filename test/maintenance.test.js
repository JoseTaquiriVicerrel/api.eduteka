import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';

describe('modo mantenimiento', () => {
    let ctx;
    before(async () => { ctx = await bootTestApp({ APP_MAINTENANCE: 'true' }); });
    after(() => ctx.stop());

    it('/config sigue respondiendo y avisa del mantenimiento', async () => {
        const res = await request(ctx.app).get('/api/v1/config').expect(200);
        assert.equal(res.body.data.maintenance, true);
    });

    it('el resto de la API responde 503 MAINTENANCE', async () => {
        const res = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x' }).expect(503);
        assert.equal(res.body.error.code, 'MAINTENANCE');
    });
});
