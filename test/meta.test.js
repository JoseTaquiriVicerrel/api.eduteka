import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';

describe('meta y convenciones globales', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ APP_MIN_VERSION: '1.4.0', APP_LATEST_VERSION: '1.6.0', SUPPORT_WHATSAPP: '51999999999' });
    });
    after(() => ctx.stop());

    it('GET /config devuelve el contrato para la app', async () => {
        const res = await request(ctx.app).get('/api/v1/config').expect(200);
        assert.deepEqual(res.body, {
            data: {
                min_version: '1.4.0',
                latest_version: '1.6.0',
                payments_enabled: true,
                maintenance: false,
                web_url: 'https://eduteka.test',
                support_whatsapp: '51999999999',
            },
        });
    });

    it('GET /health informa Mongo y Redis (Redis en memoria = degraded, 200 fuera de produccion)', async () => {
        const res = await request(ctx.app).get('/api/v1/health').expect(200);
        assert.equal(res.body.data.checks.mongo, 'up');
        assert.equal(res.body.data.checks.redis, 'memory');
        assert.equal(res.body.data.status, 'degraded');
    });

    it('todas las respuestas llevan Cache-Control: no-store y X-Request-Id', async () => {
        const res = await request(ctx.app).get('/api/v1/config').expect(200);
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.match(res.headers['x-request-id'], /^[A-Za-z0-9._-]+$/);
    });

    it('respeta un X-Request-Id entrante y lo devuelve en los errores', async () => {
        const res = await request(ctx.app).get('/api/v1/no-existe').set('X-Request-Id', 'abc-123').expect(404);
        assert.equal(res.headers['x-request-id'], 'abc-123');
        assert.equal(res.body.request_id, 'abc-123');
        assert.equal(res.body.error.code, 'NOT_FOUND');
    });

    it('descarta un X-Request-Id con caracteres raros', async () => {
        const res = await request(ctx.app).get('/api/v1/config').set('X-Request-Id', 'abc def').expect(200);
        assert.notEqual(res.headers['x-request-id'], 'abc def');
    });

    it('JSON mal formado -> 400 BAD_REQUEST con envelope', async () => {
        const res = await request(ctx.app)
            .post('/api/v1/auth/login')
            .set('Content-Type', 'application/json')
            .send('{"email": ')
            .expect(400);
        assert.equal(res.body.error.code, 'BAD_REQUEST');
        assert.ok(res.body.request_id);
    });

    it('cuerpo demasiado grande -> 413', async () => {
        const res = await request(ctx.app)
            .post('/api/v1/auth/login')
            .send({ email: 'a@b.co', password: 'x'.repeat(200_000) })
            .expect(413);
        assert.equal(res.body.error.code, 'PAYLOAD_TOO_LARGE');
    });

    it('X-App-Version por debajo del minimo -> 426, salvo en /config', async () => {
        const blocked = await request(ctx.app).post('/api/v1/auth/login').set('X-App-Version', '1.3.9').send({}).expect(426);
        assert.equal(blocked.body.error.code, 'APP_UPDATE_REQUIRED');

        await request(ctx.app).get('/api/v1/config').set('X-App-Version', '1.0.0').expect(200);
        // Una version igual o mayor pasa (falla despues por validacion, no por version).
        const passed = await request(ctx.app).post('/api/v1/auth/login').set('X-App-Version', '1.4.0').send({}).expect(422);
        assert.equal(passed.body.error.code, 'VALIDATION_ERROR');
    });

    it('sin X-App-Version no se bloquea (web, curl)', async () => {
        await request(ctx.app).post('/api/v1/auth/login').send({}).expect(422);
    });

    it('CORS: un origen no listado no recibe cabeceras CORS', async () => {
        const res = await request(ctx.app).get('/api/v1/config').set('Origin', 'https://malo.example').expect(200);
        assert.equal(res.headers['access-control-allow-origin'], undefined);
    });
});
