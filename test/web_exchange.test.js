import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { BASE_ENV } from './helpers/env.js';
import { bootTestApp } from './helpers/boot.js';
import { createUser } from './helpers/seed.js';

const run = promisify(execFile);
const SECRET = 'secreto-web-de-prueba-0123456789abcdef';
const TTL = 600;

// Monolito falso: GET /api/web/me responde segun la cookie `session` recibida, como el
// meController del monolito. Guarda cada peticion para comprobar que llego (o que no).
const sessions = new Map();
const received = [];
const monolith = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    const session = /^session=(.*)$/.exec(req.headers.cookie ?? '')?.[1];
    const reply = sessions.get(session) ?? { data: null };
    if (reply === 'lenta') return setTimeout(() => res.end('{}'), 4000).unref();
    if (reply === 'caida') {
        res.writeHead(500);
        return res.end('error');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=renovada; HttpOnly' });
    return res.end(JSON.stringify(reply));
});
await new Promise((resolve) => monolith.listen(0, '127.0.0.1', resolve));
const MONOLITH_URL = `http://127.0.0.1:${monolith.address().port}/`;

describe('POST /auth/web-exchange (puente de sesion de la web)', () => {
    let ctx;
    let user;
    let verifyAccessToken;

    before(async () => {
        ctx = await bootTestApp({
            WEB_CLIENT_SECRET: SECRET,
            MONOLITH_URL,
            WEB_BRIDGE_TTL_SECONDS: String(TTL),
            RATE_LIMIT_AUTH: '10',
            // Cada caso llega con su propia IP (X-Forwarded-For), como la web tras el punto 3.
            TRUST_PROXY: 'true',
        });
        ({ verifyAccessToken } = await import('#Libs/tokens.js'));
        user = await createUser(ctx);
        user.id = (await verifyAccessToken(user.session.access_token)).uid;
        await ctx.User.collection.insertOne({ _id: 'usuario-desactivado', email: 'off@example.com', rol: 'User', state: false, isVerified: true });

        sessions.set('valida', { data: { id: user.id, rol: 'User', username: 'Usuario Semilla' } });
        sessions.set('desactivada', { data: { id: 'usuario-desactivado' } });
        sessions.set('fantasma', { data: { id: 'no-existe' } });
        sessions.set('anonima', { data: null });
        sessions.set('lenta', 'lenta');
        sessions.set('caida', 'caida');
    });
    after(async () => {
        await ctx.stop();
        monolith.closeAllConnections();
        monolith.close();
    });

    let ipCounter = 0;
    const nextIp = () => `203.0.113.${(ipCounter += 1)}`;
    const exchange = (body, { web = true, secret = SECRET, ip = nextIp() } = {}) => {
        const req = request(ctx.app).post('/api/v1/auth/web-exchange').set('X-Forwarded-For', ip);
        if (web) req.set('X-Edk-Client', 'web').set('X-Edk-Client-Secret', secret);
        return req.send(body);
    };

    describe('solo para el cliente web', () => {
        it('sin cabeceras de cliente: 404, aunque el body sea invalido', async () => {
            const res = await exchange({ nada: 1 }, { web: false }).expect(404);
            assert.equal(res.body.error.code, 'NOT_FOUND');
        });

        it('X-Edk-Client: web con secreto erroneo: 404', async () => {
            const before = received.length;
            await exchange({ session: 'valida' }, { secret: 'no-es-el-secreto' }).expect(404);
            assert.equal(received.length, before, 'no llama al monolito');
        });

        it('cliente web sin MONOLITH_URL: 404', async () => {
            const code = `
                const { default: request } = await import('supertest');
                const { createApp } = await import('./src/app.js');
                const res = await request(createApp()).post('/api/v1/auth/web-exchange')
                    .set('X-Edk-Client', 'web').set('X-Edk-Client-Secret', ${JSON.stringify(SECRET)})
                    .send({ session: 'valida' });
                console.log(res.status);
                process.exit(0);
            `;
            const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code], {
                cwd: process.cwd(),
                // Sin logs: el LOG_LEVEL de un .env local ensuciaria el stdout que se compara.
                env: { ...process.env, ...BASE_ENV, WEB_CLIENT_SECRET: SECRET, MONOLITH_URL: '', LOG_LEVEL: 'silent' },
            });
            assert.equal(stdout.trim(), '404');
        });
    });

    describe('validacion', () => {
        it('body sin session: 422', async () => {
            const res = await exchange({}).expect(422);
            assert.equal(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('session que no es string o pasa de 2048 caracteres: 422', async () => {
            await exchange({ session: 123 }).expect(422);
            await exchange({ session: 'a'.repeat(2049) }).expect(422);
        });

        for (const session of ['valida; admin=1', 'valida otra', 'valida,x', 'valida\r\nX-Inyectada: 1']) {
            it(`intento de inyeccion ${JSON.stringify(session)}: 422 sin llamar al monolito`, async () => {
                const before = received.length;
                await exchange({ session }).expect(422);
                assert.equal(received.length, before);
            });
        }
    });

    describe('sesion segun el monolito', () => {
        it('session=valida: 200 con un access token del puente', async () => {
            const res = await exchange({ session: 'valida' }).expect(200);
            const { data } = res.body;
            assert.deepEqual(Object.keys(data).sort(), ['access_token', 'expires_in', 'token_type']);
            assert.equal(data.token_type, 'Bearer');
            assert.equal(data.expires_in, TTL);

            const payload = await verifyAccessToken(data.access_token);
            assert.equal(payload.uid, user.id);
            assert.equal(payload.typ, 'access');
            assert.equal(payload.via, 'web-bridge');
            assert.equal(payload.exp - payload.iat, TTL);
        });

        it('el token sirve en GET /auth/me como Bearer', async () => {
            const { body } = await exchange({ session: 'valida' }).expect(200);
            const me = await request(ctx.app).get('/api/v1/auth/me')
                .set('Authorization', `Bearer ${body.data.access_token}`).expect(200);
            assert.equal(me.body.data.email, user.email);
        });

        it('el monolito recibe exactamente la cookie y la IP del visitante', async () => {
            await exchange({ session: 'valida' }, { ip: '198.51.100.7' }).expect(200);
            const last = received.at(-1);
            assert.equal(last.url, '/api/web/me');
            assert.equal(last.headers.cookie, 'session=valida');
            assert.equal(last.headers.accept, 'application/json');
            assert.equal(last.headers['x-requested-with'], 'fetch');
            assert.equal(last.headers['x-forwarded-for'], '198.51.100.7');
        });

        it('session=anonima (data: null): 401', async () => {
            const res = await exchange({ session: 'anonima' }).expect(401);
            assert.equal(res.body.error.code, 'UNAUTHENTICATED');
        });

        it('usuario con state: false o que no existe: 401', async () => {
            assert.equal((await exchange({ session: 'desactivada' }).expect(401)).body.error.code, 'UNAUTHENTICATED');
            assert.equal((await exchange({ session: 'fantasma' }).expect(401)).body.error.code, 'UNAUTHENTICATED');
        });

        it('session=caida (500 del monolito): 503 BRIDGE_UNAVAILABLE', async () => {
            const res = await exchange({ session: 'caida' }).expect(503);
            assert.equal(res.body.error.code, 'BRIDGE_UNAVAILABLE');
        });

        it('session=lenta: 503 a los ~3 s, sin colgarse', async () => {
            const started = Date.now();
            const res = await exchange({ session: 'lenta' }).expect(503);
            const elapsed = Date.now() - started;
            assert.equal(res.body.error.code, 'BRIDGE_UNAVAILABLE');
            assert.ok(elapsed >= 2900 && elapsed < 3900, `tardo ${elapsed} ms`);
        });
    });

    it('limite auth por IP: la 11.a peticion seguida da 429', async () => {
        const ip = '192.0.2.50';
        for (let i = 0; i < 10; i += 1) await exchange({ session: 'valida' }, { ip }).expect(200);
        const res = await exchange({ session: 'valida' }, { ip }).expect(429);
        assert.equal(res.body.error.code, 'TOO_MANY_REQUESTS');
        // Otra IP no comparte el cupo.
        await exchange({ session: 'valida' }).expect(200);
    });
});
