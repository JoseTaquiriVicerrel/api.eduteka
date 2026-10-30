import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { BASE_ENV } from './helpers/env.js';
import { bootTestApp } from './helpers/boot.js';
import { seedCatalog } from './helpers/seed.js';

const run = promisify(execFile);
const SECRET = 'secreto-web-de-prueba-0123456789abcdef';

// settings se lee una sola vez al cargarse: lo que depende de otra configuracion
// (secreto sin definir, validaciones de arranque) corre en un proceso aparte.
const runWithEnv = (env, code) => run(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env, ...BASE_ENV, ...env },
});

const IDENTIFY_SNIPPET = `
    const { default: identifyClient } = await import('#Middlewares/client.js');
    const headers = { 'x-edk-client': 'web', 'x-edk-client-secret': ${JSON.stringify(SECRET)} };
    const req = { headers, get: (name) => headers[name.toLowerCase()] };
    identifyClient(req, {}, () => {});
    console.log(req.client);
`;

const fakeReq = (headers = {}) => {
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return { headers: lower, get: (name) => lower[name.toLowerCase()] };
};

describe('identificar al cliente web', () => {
    let ctx;
    let identifyClient;
    let redact;

    before(async () => {
        ctx = await bootTestApp({ WEB_CLIENT_SECRET: SECRET });
        await seedCatalog(ctx);
        ({ default: identifyClient } = await import('#Middlewares/client.js'));
        ({ redact } = await import('#Libs/logger.js'));
    });
    after(() => ctx.stop());

    const identify = (headers) => {
        const req = fakeReq(headers);
        let called = false;
        identifyClient(req, {}, () => { called = true; });
        assert.equal(called, true, 'nunca corta la peticion');
        return req;
    };

    describe('middleware', () => {
        const cases = [
            ['sin cabeceras', {}, 'app'],
            ['web sin secreto', { 'X-Edk-Client': 'web' }, 'app'],
            ['web con secreto erroneo', { 'X-Edk-Client': 'web', 'X-Edk-Client-Secret': SECRET.replace(/.$/, 'X') }, 'app'],
            ['web con un caracter de mas', { 'X-Edk-Client': 'web', 'X-Edk-Client-Secret': `${SECRET}x` }, 'app'],
            ['web con un caracter de menos', { 'X-Edk-Client': 'web', 'X-Edk-Client-Secret': SECRET.slice(0, -1) }, 'app'],
            ['web con secreto correcto', { 'X-Edk-Client': 'web', 'X-Edk-Client-Secret': SECRET }, 'web'],
            ['WEB con mayusculas y espacios', { 'X-Edk-Client': '  WEB ', 'X-Edk-Client-Secret': SECRET }, 'web'],
            ['app con secreto correcto', { 'X-Edk-Client': 'app', 'X-Edk-Client-Secret': SECRET }, 'app'],
            ['secreto correcto sin X-Edk-Client', { 'X-Edk-Client-Secret': SECRET }, 'app'],
        ];
        for (const [name, headers, expected] of cases) {
            it(`${name} -> ${expected}`, () => assert.equal(identify(headers).client, expected));
        }

        it('borra el secreto de req.headers', () => {
            const req = identify({ 'X-Edk-Client': 'web', 'X-Edk-Client-Secret': SECRET });
            assert.equal('x-edk-client-secret' in req.headers, false);
            assert.equal(req.headers['x-edk-client'], 'web');
        });

        it('secreto correcto pero WEB_CLIENT_SECRET sin configurar en la API -> app', async () => {
            const { stdout } = await runWithEnv({ WEB_CLIENT_SECRET: '' }, IDENTIFY_SNIPPET);
            assert.equal(stdout.trim(), 'app');
        });
    });

    describe('integracion', () => {
        // Lo que varia entre dos peticiones identicas.
        const stable = (body) => JSON.parse(JSON.stringify(body, (key, value) => (key === 'request_id' ? undefined : value)));

        it('un secreto invalido responde igual que sin cabeceras (nunca 401/403)', async () => {
            const plain = await request(ctx.app).get('/api/v1/instituciones');
            const forged = await request(ctx.app).get('/api/v1/instituciones')
                .set('X-Edk-Client', 'web').set('X-Edk-Client-Secret', 'no-es-el-secreto');
            assert.equal(plain.status, 200);
            assert.equal(forged.status, plain.status);
            assert.deepEqual(stable(forged.body), stable(plain.body));
        });

        it('req.client llega a las rutas de /api/v1 y el secreto ya no', async () => {
            const { buildV1Router } = await import('#Modules/index.js');
            const app = express();
            app.use('/api/v1', buildV1Router());
            app.get('/api/v1/__cliente', (req, res) => res.json({ client: req.client, secret: req.headers['x-edk-client-secret'] ?? null }));

            const web = await request(app).get('/api/v1/__cliente').set('X-Edk-Client', 'web').set('X-Edk-Client-Secret', SECRET).expect(200);
            assert.deepEqual(web.body, { client: 'web', secret: null });
            const anon = await request(app).get('/api/v1/__cliente').expect(200);
            assert.deepEqual(anon.body, { client: 'app', secret: null });
        });

        it('CORS: el navegador no puede enviar las cabeceras de cliente', async () => {
            const res = await request(ctx.app).options('/api/v1/instituciones')
                .set('Origin', 'https://otro.example')
                .set('Access-Control-Request-Method', 'GET')
                .set('Access-Control-Request-Headers', 'x-edk-client, x-edk-client-secret');
            const allowed = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
            assert.equal(allowed.includes('x-edk-client'), false);
        });
    });

    describe('logs', () => {
        it('la configuracion de redact oculta la cabecera aunque se registre antes de borrarla', () => {
            const lines = [];
            const logger = pino({ level: 'info', redact }, { write: (line) => lines.push(line) });
            logger.info({ req: { headers: { 'x-edk-client-secret': SECRET } } });
            assert.equal(lines.join('').includes(SECRET), false);
            assert.match(lines[0], /\[oculto\]/);
        });

        it('con pino-http y el middleware: el secreto no aparece en el log', async () => {
            const lines = [];
            const logger = pino({ level: 'info', redact }, { write: (line) => lines.push(line) });
            const app = express();
            app.use(pinoHttp({ logger }));
            app.use(identifyClient);
            app.get('/x', (req, res) => res.json({ client: req.client }));

            await request(app).get('/x').set('X-Edk-Client', 'web').set('X-Edk-Client-Secret', SECRET).expect(200);
            assert.ok(lines.length > 0);
            assert.equal(lines.join('').includes(SECRET), false);
        });
    });

    describe('configuracion', () => {
        const LOAD = "await import('#Config/settings.js'); console.log('ok');";
        const failsWith = async (env, message) => {
            await assert.rejects(runWithEnv(env, LOAD), (error) => {
                assert.match(error.stderr, message);
                return true;
            });
        };

        it('WEB_CLIENT_SECRET con menos de 32 caracteres: el arranque falla', async () => {
            await failsWith({ WEB_CLIENT_SECRET: 'corto' }, /WEB_CLIENT_SECRET debe tener al menos 32 caracteres/);
        });

        // Produccion exige proveedor de correo real; resend con una clave falsa basta para cargar settings.
        const PROD = { NODE_ENV: 'production', MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_prueba', PAYMENT_AI_PROVIDER: 'none', BCRYPT_ROUNDS: '10', JWT_PRIVATE_KEY: 'clave-del-monolito-0123456789abcdefghij' };

        it('en produccion, igual a JWT_SECRET: el arranque falla', async () => {
            await failsWith({ ...PROD, WEB_CLIENT_SECRET: BASE_ENV.JWT_SECRET }, /WEB_CLIENT_SECRET debe ser distinto de JWT_SECRET/);
        });

        it('en produccion, igual a JWT_PRIVATE_KEY: el arranque falla', async () => {
            await failsWith({ ...PROD, WEB_CLIENT_SECRET: PROD.JWT_PRIVATE_KEY }, /WEB_CLIENT_SECRET debe ser distinto de JWT_PRIVATE_KEY/);
        });

        it('en produccion, con un secreto valido y distinto: arranca', async () => {
            const { stdout } = await runWithEnv({ ...PROD, WEB_CLIENT_SECRET: SECRET }, LOAD);
            assert.equal(stdout.trim(), 'ok');
        });
    });
});
