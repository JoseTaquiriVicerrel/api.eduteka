import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Jimp from 'jimp-compact';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser } from './helpers/seed.js';

// Kill-switch remoto de la tienda (`/config.payments_enabled`). Archivo propio: la
// configuracion se lee una vez por proceso.
describe('pagos desactivados (APP_PAYMENTS_ENABLED=false)', () => {
    let ctx;
    let filesRoot;
    before(async () => {
        filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eduteka-nopay-'));
        ctx = await bootTestApp({ FILES_ROOT_DIR: filesRoot, APP_PAYMENTS_ENABLED: 'false' });
        await ctx.mongoose.connection.db.collection('suscriptions').insertOne({ _id: 'plan-anual', name: '1 año', slug: 'anual', price: 60, duration_months: 12, state: true });
        await ctx.mongoose.connection.db.collection('products').insertOne({ _id: 'p1', name: 'Guía', slug: 'guia', price: 10, state: true });
    });
    after(async () => {
        await ctx.stop();
        fs.rmSync(filesRoot, { recursive: true, force: true });
    });

    it('el catalogo sigue visible pero checkout y suscripcion dan 403', async () => {
        const png = await new Jimp(20, 20, 0x000000ff).getBufferAsync(Jimp.MIME_PNG);
        const user = await createUser(ctx);
        await request(ctx.app).get('/api/v1/productos').expect(200);
        await request(ctx.app).get('/api/v1/suscripciones').expect(200);

        const order = await request(ctx.app).post('/api/v1/tienda/checkout').set(bearer(user))
            .field('items', JSON.stringify([{ product_id: 'p1' }])).field('payment_method', 'yape')
            .attach('payment_proof', png, { filename: 'a.png', contentType: 'image/png' })
            .expect(403);
        assert.equal(order.body.error.code, 'FORBIDDEN');

        await request(ctx.app).post('/api/v1/suscripciones/anual/suscribirme').set(bearer(user))
            .attach('payment_proof', png, { filename: 'a.png', contentType: 'image/png' })
            .expect(403);
        assert.equal(fs.existsSync(path.join(filesRoot, 'storage')), false);
    });
});
