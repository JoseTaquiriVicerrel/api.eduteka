import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp, lastCode, settle } from './helpers/boot.js';

// Enfriamiento entre envios de codigo: 60 s por correo y por proposito.
describe('enfriamiento de codigos', () => {
    let ctx;
    before(async () => { ctx = await bootTestApp({ CODE_COOLDOWN_SECONDS: '60' }); });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const post = (path, body) => request(ctx.app).post(`/api/v1/auth${path}`).send(body);
    const user = (email) => ({ email, password: 'Passw0rd!', username: 'Usuario Prueba', departament: 'Lima', account_type: 'Estudiante' });

    it('reenviar justo despues de registrarse -> 429 con Retry-After; pasado el enfriamiento, 200', async () => {
        await post('/register', user('cool1@example.com')).expect(201);

        const res = await post('/resend-code', { email: 'cool1@example.com' }).expect(429);
        assert.equal(res.body.error.code, 'TOO_MANY_REQUESTS');
        const retryAfter = Number(res.headers['retry-after']);
        assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After=${retryAfter}`);

        ctx.kv.flushMemory();
        await post('/resend-code', { email: 'cool1@example.com' }).expect(200);
        await settle();
        assert.equal(ctx.outbox.filter((mail) => mail.to === 'cool1@example.com').length, 2);
    });

    it('el enfriamiento no delata si el correo existe: un correo inexistente tambien lo recibe', async () => {
        await post('/resend-code', { email: 'fantasma@example.com' }).expect(200);
        const second = await post('/resend-code', { email: 'fantasma@example.com' }).expect(429);
        assert.equal(second.body.error.code, 'TOO_MANY_REQUESTS');
    });

    it('recuperar contraseña tiene su propio enfriamiento, independiente del de verificacion', async () => {
        await post('/register', user('cool2@example.com')).expect(201);
        await post('/recover', { email: 'cool2@example.com' }).expect(200);
        await post('/recover', { email: 'cool2@example.com' }).expect(429);
    });

    it('si el envio del correo falla en el registro, el enfriamiento se libera para poder reintentar', async () => {
        const original = ctx.outbox.push;
        ctx.outbox.push = () => { throw new Error('smtp caido'); };
        try {
            await post('/register', user('cool3@example.com')).expect(503);
        } finally {
            ctx.outbox.push = original;
        }
        // Sin esperar 60 s: la cuenta existe sin verificar y se puede registrar de nuevo.
        await post('/register', user('cool3@example.com')).expect(201);
        assert.match(lastCode(ctx.outbox, 'cool3@example.com'), /^\d{6}$/);
    });
});
