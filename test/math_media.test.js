import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';

const API = '/api/v1';

describe('GET /media/math/:file', () => {
    let ctx;
    let storageDir;
    let asset;
    let svg;

    before(async () => {
        storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'math-media-'));
        // RATE_LIMIT_GLOBAL bajo a proposito: los SVG no deben consumirlo.
        ctx = await bootTestApp({ STORAGE_DIR: storageDir, RATE_LIMIT_GLOBAL: '3' });
        // El almacen por defecto escribe en STORAGE_DIR/math, que es de donde sirve la ruta.
        const { mathStore } = await import('#Libs/math_store.js');
        asset = await mathStore().getAsset({ tex: String.raw`\frac{a}{b}`, mode: 'block' });
        svg = await fs.readFile(path.join(storageDir, 'math', `${asset.hash}.svg`), 'utf8');
    });

    after(async () => {
        const { mathStore } = await import('#Libs/math_store.js');
        mathStore().close();
        await ctx.stop();
        await fs.rm(storageDir, { recursive: true, force: true });
    });

    const get = (file) => request(ctx.app).get(`${API}/media/math/${file}`);

    it('sirve el SVG con tipo, cache inmutable y CSP restrictiva, sin autenticacion', async () => {
        const res = await get(`${asset.hash}.svg`).expect(200);
        assert.match(res.headers['content-type'], /^image\/svg\+xml/);
        assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.match(res.headers['content-security-policy'], /default-src 'none'/);
        assert.match(res.headers['content-security-policy'], /style-src 'unsafe-inline'/);
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
        assert.ok(res.headers.etag);
        assert.equal(res.body.toString(), svg);
    });

    it('con If-None-Match responde 304', async () => {
        const first = await get(`${asset.hash}.svg`).expect(200);
        const res = await get(`${asset.hash}.svg`).set('If-None-Match', first.headers.etag).expect(304);
        assert.equal(res.text, '');
    });

    it('HEAD funciona', async () => {
        const res = await request(ctx.app).head(`${API}/media/math/${asset.hash}.svg`).expect(200);
        assert.match(res.headers['content-type'], /^image\/svg\+xml/);
    });

    it('archivo inexistente -> 404 (la app cae a KaTeX)', async () => {
        const res = await get(`${'0'.repeat(32)}.svg`).expect(404);
        assert.equal(res.body.error.code, 'NOT_FOUND');
    });

    it('nombres invalidos o fuera del directorio -> 404', async () => {
        for (const name of [
            '..%2f..%2fpackage.json',
            '..%5C..%5Cpackage.json',
            `${asset.hash}.json`, // las medidas no se sirven
            `${asset.hash}.svg.tmp`,
            `${asset.hash.toUpperCase()}.svg`,
            `${asset.hash.slice(1)}.svg`,
            '.svg',
            'secreto.txt',
        ]) {
            await get(name).expect(404);
        }
    });

    it('no consume el limite global: 10 peticiones con RATE_LIMIT_GLOBAL=3', async () => {
        for (let i = 0; i < 10; i += 1) {
            const res = await get(`${asset.hash}.svg`).expect(200);
            assert.equal(res.headers['ratelimit-limit'], undefined);
        }
        // El resto de la API sigue limitada (la exencion es solo de esta ruta).
        let limited = false;
        for (let i = 0; i < 6 && !limited; i += 1) {
            limited = (await request(ctx.app).get(`${API}/media/avatars/no-existe.jpg`)).status === 429;
        }
        assert.ok(limited, 'las demas rutas siguen con rate limit');
    });
});
