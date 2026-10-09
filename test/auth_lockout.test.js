import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { createUser } from './helpers/seed.js';

// Bloqueo de login: por correo + IP (3 aqui) y por correo en total (6 aqui). Un atacante solo
// deja fuera al dueño de la cuenta si reune muchos fallos desde muchas IP; desde una sola IP
// solo se bloquea a si mismo. La configuracion se lee una vez por proceso: archivo propio.

let ctx;
let user;

before(async () => {
    ctx = await bootTestApp({ TRUST_PROXY: '1', LOGIN_MAX_FAILURES: '3', LOGIN_MAX_FAILURES_PER_EMAIL: '6', BCRYPT_ROUNDS: '5' });
    user = await createUser(ctx);
});
after(() => ctx.stop());
beforeEach(() => ctx.kv.flushMemory());

const login = (ip, password = user.password, email = user.email) =>
    request(ctx.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email, password });

describe('bloqueo de login por correo + IP y por correo total', () => {
    it('desde una sola IP se bloquea esa IP, no la cuenta: el dueño entra desde otra', async () => {
        for (let i = 0; i < 3; i += 1) await login('203.0.113.10', 'incorrecta-1').expect(401);

        const blocked = await login('203.0.113.10').expect(429);
        assert.ok(Number(blocked.headers['retry-after']) > 0);

        await login('198.51.100.7').expect(200);
    });

    it('un acierto reinicia el contador de ese correo + IP', async () => {
        await login('203.0.113.20', 'incorrecta-1').expect(401);
        await login('203.0.113.20', 'incorrecta-1').expect(401);
        await login('203.0.113.20').expect(200);
        for (let i = 0; i < 2; i += 1) await login('203.0.113.20', 'incorrecta-1').expect(401);
        await login('203.0.113.20').expect(200);
    });

    it('un ataque repartido entre muchas IP si alcanza el tope por correo', async () => {
        // 6 fallos desde 6 IP distintas: ninguna llega a 3, pero el correo suma 6.
        for (let i = 1; i <= 6; i += 1) await login(`192.0.2.${i}`, 'incorrecta-1').expect(401);

        const res = await login('192.0.2.200').expect(429);
        assert.equal(res.body.error.code, 'TOO_MANY_REQUESTS');
    });

    it('los fallos de un correo no afectan a otro', async () => {
        for (let i = 0; i < 3; i += 1) await login('203.0.113.30', 'incorrecta-1').expect(401);
        const other = await createUser(ctx);
        await login('203.0.113.30', other.password, other.email).expect(200);
    });
});

describe('bcrypt: hashes antiguos se actualizan al iniciar sesion', () => {
    it('un hash con menos rondas se rehace con las actuales; uno ya al dia no cambia', async () => {
        const old = await createUser(ctx);
        const weak = bcrypt.hashSync(old.password, 4);
        await ctx.User.updateOne({ _id: old.session.user.id }, { $set: { password: weak } });

        await request(ctx.app).post('/api/v1/auth/login').send({ email: old.email, password: 'incorrecta-1' }).expect(401);
        assert.equal((await ctx.User.findById(old.session.user.id).select('+password').lean()).password, weak, 'un fallo no cambia nada');

        await request(ctx.app).post('/api/v1/auth/login').send({ email: old.email, password: old.password }).expect(200);
        const upgraded = (await ctx.User.findById(old.session.user.id).select('+password').lean()).password;
        assert.equal(bcrypt.getRounds(upgraded), 5);
        assert.equal(bcrypt.compareSync(old.password, upgraded), true, 'la contraseña sigue siendo la misma');

        await request(ctx.app).post('/api/v1/auth/login').send({ email: old.email, password: old.password }).expect(200);
        assert.equal((await ctx.User.findById(old.session.user.id).select('+password').lean()).password, upgraded);
    });
});
