import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Jimp from 'jimp-compact';
import request from 'supertest';
import { bootTestApp, settle } from './helpers/boot.js';
import { bearer, createUser } from './helpers/seed.js';

const API = '/api/v1';
const day = (n) => new Date(Date.UTC(2026, 0, n));

// Productos gratuitos (is_free) en el catalogo, la ficha, el carrito y el checkout.
describe('tienda: productos gratuitos', () => {
    let ctx;
    let filesRoot;
    let png;

    before(async () => {
        filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eduteka-store-free-'));
        ctx = await bootTestApp({ FILES_ROOT_DIR: filesRoot, ADMIN_EMAIL: 'admin@eduteka.test' });
        png = await new Jimp(60, 60, 0x22aa66ff).getBufferAsync(Jimp.MIME_PNG);

        const db = ctx.mongoose.connection.db;
        const unmsm = { id: 'inst-unmsm', name: 'UNMSM', abrev: 'SM' };
        await db.collection('exams').insertMany([
            // El PDF del examen gratis; el de pago sirve para comprobar que `download` no aparece.
            { _id: 'ex-libre', slug: 'libre-2025', title: 'Examen libre', verified: true, is_free: true, institution: unmsm, files: { A: { path: 'storage/examenes/libre-a.pdf', title: 'Cuadernillo A' } } },
            { _id: 'ex-pago', slug: 'pago-2025', title: 'Examen de pago', verified: true, is_free: false, institution: unmsm, files: { A: { path: 'storage/examenes/pago-a.pdf', title: 'Cuadernillo A' } } },
            { _id: 'ex-borrador', slug: 'libre-borrador', title: 'Libre sin publicar', verified: false, is_free: true, institution: unmsm, files: { A: { path: 'storage/examenes/b.pdf' } } },
        ]);
        await db.collection('products').insertMany([
            {
                _id: 'p-libre', name: 'Examen libre', slug: 'libre-2025', type: 'Examen', type_file: 'PDF', price: 0, is_free: true,
                state: true, unique: true, source: 'ex-libre', created_at: day(5), areas: { I: { abrev: 'I', title: 'Único', verified: true } },
                files: [{ name: 'Cuadernillo A', path: 'storage/examenes/libre-a.pdf', area: 'A' }],
            },
            { _id: 'p-borrador', name: 'Libre sin publicar', slug: 'libre-borrador', type: 'Examen', price: 0, is_free: true, state: true, unique: true, source: 'ex-borrador', created_at: day(4), areas: { I: { abrev: 'I', title: 'Único', verified: true } } },
            { _id: 'p-pago', name: 'Examen de pago', slug: 'pago-2025', type: 'Examen', price: 2.5, state: true, unique: true, source: 'ex-pago', created_at: day(3), areas: { I: { abrev: 'I', title: 'Único', verified: true } }, files: [{ name: 'A', path: 'storage/examenes/pago-a.pdf', area: 'A' }] },
            { _id: 'p-guia', name: 'Guía de álgebra', slug: 'guia-algebra', type: 'Material', price: 10, state: true, created_at: day(2) },
        ]);
    });
    after(async () => {
        await ctx.stop();
        fs.rmSync(filesRoot, { recursive: true, force: true });
    });

    const get = (route, user) => request(ctx.app).get(`${API}${route}`).set(user ? bearer(user) : {});
    const resolve = (items) => request(ctx.app).post(`${API}/tienda/carrito/resolver`).send({ items });
    const checkout = (user, items, { expected } = {}) => {
        const req = request(ctx.app).post(`${API}/tienda/checkout`).set(bearer(user)).field('payment_method', 'yape').field('items', JSON.stringify(items));
        if (expected !== undefined) req.field('expected_total', String(expected));
        return req.attach('payment_proof', png, { filename: 'pago.png', contentType: 'image/png' });
    };

    describe('catalogo y ficha', () => {
        it('cada producto indica is_free', async () => {
            const res = await get('/productos').expect(200);
            const free = Object.fromEntries(res.body.data.map((product) => [product.id, product.is_free]));
            assert.deepEqual(free, { 'p-libre': true, 'p-borrador': true, 'p-pago': false, 'p-guia': false });
            assert.equal(res.body.data.find((product) => product.id === 'p-libre').price, 0);
        });

        it('?free=true lista solo los gratuitos; ?free=false no filtra; un valor invalido es 422', async () => {
            const only = await get('/productos?free=true').expect(200);
            assert.deepEqual(only.body.data.map((product) => product.id), ['p-libre', 'p-borrador']);
            assert.equal(only.body.meta.total, 2);

            assert.equal((await get('/productos?free=false').expect(200)).body.meta.total, 4);
            assert.deepEqual((await get('/productos?free=true&type=Material').expect(200)).body.data, []);
            await get('/productos?free=quizas').expect(422);
        });

        it('la ficha de un gratuito informa de la descarga: anonimo debe iniciar sesion', async () => {
            const { data } = (await get('/productos/libre-2025').expect(200)).body;
            assert.equal(data.is_free, true);
            assert.equal(data.download.exam_slug, 'libre-2025');
            assert.equal(data.download.can_download, false);
            assert.equal(data.download.download_requires, 'login');
            assert.deepEqual(data.download.files, [{ area: 'A', title: 'Cuadernillo A', download_url: '/api/v1/examenes/libre-2025/pdf?area=A' }]);
            assert.equal(JSON.stringify(data).includes('storage/'), false);
        });

        it('con sesion y sin plan ya puede descargar; un token invalido se trata como anonimo', async () => {
            const user = await createUser(ctx);
            const { download } = (await get('/productos/libre-2025', user).expect(200)).body.data;
            assert.equal(download.can_download, true);
            assert.equal(download.download_requires, null);

            const invalid = await request(ctx.app).get(`${API}/productos/libre-2025`).set('Authorization', 'Bearer basura').expect(200);
            assert.equal(invalid.body.data.download.download_requires, 'login');
        });

        it('un producto de pago no trae descarga; uno gratis cuyo examen no esta publicado tampoco', async () => {
            assert.equal((await get('/productos/pago-2025').expect(200)).body.data.download, null);
            assert.equal((await get('/productos/guia-algebra').expect(200)).body.data.download, null);
            const draft = (await get('/productos/libre-borrador').expect(200)).body.data;
            assert.equal(draft.is_free, true);
            assert.equal(draft.download, null);
        });
    });

    describe('carrito', () => {
        it('un gratuito no suma: se informa en `skipped` y el total no cambia', async () => {
            const res = await resolve([{ product_id: 'p-libre' }, { product_id: 'p-guia' }]).expect(200);
            const { data } = res.body;

            assert.deepEqual(data.items.map((line) => line.product.id), ['p-guia']);
            assert.deepEqual(data.skipped, [{ product_id: 'p-libre', reason: 'FREE' }]);
            assert.deepEqual({ subtotal: data.subtotal, discount: data.discount, total: data.total }, { subtotal: 10, discount: 0, total: 10 });
            assert.deepEqual(data.unavailable, []);
        });

        it('un carrito solo de gratuitos queda vacio, sin error', async () => {
            const { data } = (await resolve([{ product_id: 'p-libre' }]).expect(200)).body;
            assert.deepEqual(data.items, []);
            assert.equal(data.total, 0);
            assert.equal(data.skipped.length, 1);
        });

        it('sin gratuitos, `skipped` viene vacio', async () => {
            const { data } = (await resolve([{ product_id: 'p-pago' }]).expect(200)).body;
            assert.deepEqual(data.skipped, []);
            assert.equal(data.items.length, 1);
        });
    });

    describe('checkout', () => {
        let buyer;
        before(async () => {
            buyer = await createUser(ctx);
        });

        it('un carrito solo de gratuitos no crea pedido ni deja comprobante (422)', async () => {
            const res = await checkout(buyer, [{ product_id: 'p-libre' }]).expect(422);
            assert.equal(res.body.error.code, 'VALIDATION_ERROR');
            assert.match(res.body.error.details[0].message, /gratuitos/);

            assert.equal(await ctx.mongoose.connection.db.collection('orders').countDocuments({ user_id: buyer.session.user.id }), 0);
            const dir = path.join(filesRoot, 'storage', 'payment', 'store');
            assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
        });

        it('un carrito mixto registra el pedido SIN el gratuito y con el total de lo pagado', async () => {
            const res = await checkout(buyer, [{ product_id: 'p-libre' }, { product_id: 'p-pago' }], { expected: 2.5 }).expect(201);
            const order = res.body.data;

            assert.equal(order.total, 2.5);
            assert.deepEqual(order.items.map((item) => item.product_id), ['p-pago']);

            const stored = await ctx.mongoose.connection.db.collection('orders').findOne({ _id: order.id });
            assert.deepEqual(stored.items.map((item) => item.product_id), ['p-pago']);
            // Correo y registro de actividad van sin await: se esperan antes de cerrar la base.
            await settle();
        });
    });
});
