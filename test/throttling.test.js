import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';

// Limites bajos para poder agotarlos: global 6/min, auth 5/min, auth-email 2/15 min.
describe('rate limiting', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ RATE_LIMIT_GLOBAL: '6', RATE_LIMIT_AUTH: '5', RATE_LIMIT_AUTH_EMAIL: '2' });
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const login = (email = 'a@example.com') =>
        request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Cualquiera1' });

    it('bucket auth: a la 6a peticion desde la misma IP -> 429 con Retry-After', async () => {
        for (let i = 0; i < 5; i += 1) await login().expect(401);

        const res = await login().expect(429);
        assert.equal(res.body.error.code, 'TOO_MANY_REQUESTS');
        assert.ok(Number(res.headers['retry-after']) >= 1);
        assert.equal(res.headers['ratelimit-remaining'], '0');
        assert.equal(res.headers['ratelimit-limit'], '5');
        assert.ok(res.body.request_id);
    });

    it('informa el cupo restante en cada respuesta', async () => {
        const first = await login().expect(401);
        const second = await login().expect(401);
        assert.equal(first.headers['ratelimit-remaining'], '4');
        assert.equal(second.headers['ratelimit-remaining'], '3');
    });

    it('bucket global: la 7a peticion -> 429, pero /health nunca se limita', async () => {
        for (let i = 0; i < 6; i += 1) await request(ctx.app).get('/api/v1/config').expect(200);
        const res = await request(ctx.app).get('/api/v1/config').expect(429);
        assert.equal(res.body.error.code, 'TOO_MANY_REQUESTS');

        for (let i = 0; i < 10; i += 1) await request(ctx.app).get('/api/v1/health').expect(200);
    });

    it('bucket auth-email: el tercer envio para el mismo correo -> 429; otro correo sigue libre', async () => {
        const send = (email) => request(ctx.app).post('/api/v1/auth/resend-code').send({ email });

        await send('uno@example.com').expect(200);
        await send('UNO@example.com').expect(200); // mismo correo aunque cambie la capitalizacion
        const blocked = await send('uno@example.com').expect(429);
        assert.equal(blocked.headers['ratelimit-limit'], '2');

        await send('otro@example.com').expect(200);
    });

    it('cada IP tiene su propio cupo (X-Forwarded-For solo cuenta con trust proxy)', async () => {
        // Sin TRUST_PROXY la cabecera se ignora: no sirve para evadir el limite.
        for (let i = 0; i < 5; i += 1) await login().set('X-Forwarded-For', `10.0.0.${i}`).expect(401);
        await login().set('X-Forwarded-For', '10.0.0.99').expect(429);
    });
});
