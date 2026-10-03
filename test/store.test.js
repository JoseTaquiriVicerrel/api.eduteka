import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Jimp from 'jimp-compact';
import request from 'supertest';
import { bootTestApp, eventually, settle } from './helpers/boot.js';
import { bearer, createUser } from './helpers/seed.js';

const day = (n) => new Date(Date.UTC(2026, 0, n));

async function seedProducts(ctx) {
    await ctx.mongoose.connection.db.collection('products').insertMany([
        {
            // Examen por areas: B no esta verificada, asi que solo se venden A y C.
            _id: 'p-examen', name: 'Examen UNMSM 2025', slug: 'examen-unmsm-2025', type: 'Examen', type_file: 'PDF', price: 2.5,
            state: true, unique: false, poster: '/images/products/unmsm.png', created_at: day(5),
            description: '<p>Examen <img src="/images/products/x.png"></p>', images: ['/images/products/a.png'],
            areas: {
                A: { abrev: 'A', title: 'Área A', verified: true, description: 'Ingenierías' },
                B: { abrev: 'B', title: 'Área B', verified: false },
                C: { abrev: 'C', title: 'Área C', verified: true },
            },
            files: [{ name: 'Examen A', path: 'storage/examenes/secreto-a.pdf', area: 'A' }, { name: 'Examen C', path: 'storage/examenes/c.pdf', area: 'C' }],
        },
        {
            _id: 'p-unico', name: 'Examen único', slug: 'examen-unico', type: 'Examen', price: 4, state: true, unique: true, created_at: day(4),
            areas: { I: { abrev: 'I', title: 'Único' } },
        },
        // Material sin mapa de areas: cuenta como una unidad de precio.
        { _id: 'p-guia', name: 'Guía de álgebra', slug: 'guia-algebra', type: 'Material', price: 10, state: true, created_at: day(3) },
        { _id: 'p-baja', name: 'Producto dado de baja', slug: 'baja', type: 'Material', price: 5, state: false, created_at: day(6) },
    ]);
}

describe('tienda', () => {
    let ctx;
    let filesRoot;
    let png;

    before(async () => {
        filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eduteka-store-'));
        ctx = await bootTestApp({ FILES_ROOT_DIR: filesRoot, ADMIN_EMAIL: 'admin@eduteka.test' });
        await seedProducts(ctx);
        png = await new Jimp(60, 60, 0x22aa66ff).getBufferAsync(Jimp.MIME_PNG);
    });
    after(async () => {
        await ctx.stop();
        fs.rmSync(filesRoot, { recursive: true, force: true });
    });

    const storedProofs = () => {
        const dir = path.join(filesRoot, 'storage', 'payment', 'store');
        return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    };

    const checkout = (user, { items, method = 'yape', proof = png, expected } = {}) => {
        const req = request(ctx.app).post('/api/v1/tienda/checkout').set(bearer(user)).field('payment_method', method);
        if (items !== undefined) req.field('items', typeof items === 'string' ? items : JSON.stringify(items));
        if (expected !== undefined) req.field('expected_total', String(expected));
        if (proof) req.attach('payment_proof', proof, { filename: 'pago.png', contentType: 'image/png' });
        return req;
    };

    describe('catalogo', () => {
        it('lista solo productos a la venta, mas recientes primero, sin rutas de archivos', async () => {
            const res = await request(ctx.app).get('/api/v1/productos').expect(200);
            assert.deepEqual(res.body.data.map((p) => p.id), ['p-examen', 'p-unico', 'p-guia']);
            assert.deepEqual(res.body.meta, { page: 1, limit: 20, total: 3, has_more: false });

            const examen = res.body.data[0];
            assert.equal(examen.price, 2.5);
            assert.equal(examen.currency, 'PEN');
            assert.equal(examen.poster, 'https://eduteka.test/images/products/unmsm.png');
            // Solo las areas verificadas, una preseleccionada.
            assert.deepEqual(examen.areas.map((a) => [a.abrev, a.checked, a.locked]), [['A', true, false], ['C', false, false]]);
            assert.equal(JSON.stringify(res.body).includes('secreto-a.pdf'), false);

            const guia = res.body.data[2];
            assert.deepEqual(guia.areas.map((a) => [a.abrev, a.locked]), [['UNICO', true]]);
        });

        it('filtra por tipo y por texto (literal) y pagina', async () => {
            const byType = await request(ctx.app).get('/api/v1/productos?type=Material').expect(200);
            assert.deepEqual(byType.body.data.map((p) => p.id), ['p-guia']);

            const byText = await request(ctx.app).get('/api/v1/productos?q=ÚNICO').expect(200);
            assert.deepEqual(byText.body.data.map((p) => p.id), ['p-unico']);

            await request(ctx.app).get('/api/v1/productos?q=(').expect(200);

            const page = await request(ctx.app).get('/api/v1/productos?limit=2&page=2').expect(200);
            assert.deepEqual(page.body.data.map((p) => p.id), ['p-guia']);
            assert.equal(page.body.meta.has_more, false);
        });

        it('detalle con descripcion, imagenes absolutas y archivos sin ruta; dado de baja = 404', async () => {
            const res = await request(ctx.app).get('/api/v1/productos/examen-unmsm-2025').expect(200);
            assert.match(res.body.data.description, /src="https:\/\/eduteka\.test\/images\/products\/x\.png"/);
            assert.deepEqual(res.body.data.images, ['https://eduteka.test/images/products/a.png']);
            assert.deepEqual(res.body.data.files, [{ name: 'Examen A', area: 'A' }, { name: 'Examen C', area: 'C' }]);
            assert.equal(JSON.stringify(res.body).includes('storage/'), false);

            const gone = await request(ctx.app).get('/api/v1/productos/baja').expect(404);
            assert.equal(gone.body.error.code, 'NOT_FOUND');
        });
    });

    describe('carrito', () => {
        const resolve = (items) => request(ctx.app).post('/api/v1/tienda/carrito/resolver').send({ items });

        it('recalcula precios por area con el descuento de examenes (sin sesion)', async () => {
            const res = await resolve([
                { product_id: 'p-examen', areas: ['A', 'C'] },
                { product_id: 'p-guia' },
            ]).expect(200);
            const { data } = res.body;
            // Examen: 2 areas x 2.5 = 5, 20 % de descuento = 1 -> 4. Guia: 10.
            assert.deepEqual(data.items.map((l) => [l.product.id, l.subtotal, l.discount, l.total]), [['p-examen', 5, 1, 4], ['p-guia', 10, 0, 10]]);
            assert.deepEqual(data.items[0].areas.map((a) => a.abrev), ['A', 'C']);
            assert.deepEqual({ subtotal: data.subtotal, discount: data.discount, total: data.total }, { subtotal: 15, discount: 1, total: 14 });
            assert.deepEqual(data.unavailable, []);
        });

        it('normaliza un carrito viejo: repetidos, productos de baja y areas invalidas', async () => {
            const res = await resolve([
                { product_id: 'p-examen', areas: ['B', 'ZZ'] }, // B no se vende: cae en la preseleccionada (A)
                { product_id: 'p-examen', areas: ['C'] }, // repetido: se descarta
                { product_id: 'p-unico', areas: ['X', 'Y'] }, // area unica: se compra completo
                { product_id: 'p-baja' },
                { product_id: 'no-existe' },
            ]).expect(200);
            const { data } = res.body;
            assert.deepEqual(data.items.map((l) => [l.product.id, l.areas.map((a) => a.abrev), l.total]), [['p-examen', ['A'], 2.5], ['p-unico', ['I'], 4]]);
            assert.deepEqual(data.unavailable, ['p-baja', 'no-existe']);
            assert.equal(data.total, 6.5);
        });

        it('valida la forma del carrito', async () => {
            const empty = await resolve([]).expect(422);
            assert.equal(empty.body.error.code, 'VALIDATION_ERROR');
            await resolve(Array.from({ length: 31 }, (_, i) => ({ product_id: `p${i}` }))).expect(422);
            await request(ctx.app).post('/api/v1/tienda/carrito/resolver').send({ items: [{ product_id: 'p-guia', price: 0 }] }).expect(422);
        });
    });

    describe('checkout y pedidos', () => {
        let buyer;
        let other;
        before(async () => {
            buyer = await createUser(ctx);
            other = await createUser(ctx);
        });

        it('exige sesion', async () => {
            const res = await request(ctx.app).post('/api/v1/tienda/checkout').field('items', '[]').expect(401);
            assert.equal(res.body.error.code, 'UNAUTHENTICATED');
        });

        it('rechaza sin escribir nada: sin comprobante, JSON roto, metodo invalido, areas invalidas o producto de baja', async () => {
            const before = storedProofs().length;

            const noProof = await checkout(buyer, { items: [{ product_id: 'p-guia' }], proof: null }).expect(422);
            assert.equal(noProof.body.error.details[0].field, 'payment_proof');

            const broken = await checkout(buyer, { items: '[{"product_id":' }).expect(422);
            assert.equal(broken.body.error.details[0].field, 'items');

            await checkout(buyer, { items: [{ product_id: 'p-guia' }], method: 'tarjeta' }).expect(422);

            const badArea = await checkout(buyer, { items: [{ product_id: 'p-examen', areas: ['B'] }] }).expect(422);
            assert.equal(badArea.body.error.details[0].field, 'items.0.areas');
            const noArea = await checkout(buyer, { items: [{ product_id: 'p-examen' }] }).expect(422);
            assert.match(noArea.body.error.details[0].message, /al menos un área/);

            const dup = await checkout(buyer, { items: [{ product_id: 'p-guia' }, { product_id: 'p-guia' }] }).expect(422);
            assert.equal(dup.body.error.details[0].field, 'items.1.product_id');

            const gone = await checkout(buyer, { items: [{ product_id: 'p-baja' }] }).expect(409);
            assert.equal(gone.body.error.code, 'CONFLICT');

            const notImage = await checkout(buyer, { items: [{ product_id: 'p-guia' }], proof: Buffer.from('no soy una imagen') }).expect(422);
            assert.equal(notImage.body.error.details[0].field, 'payment_proof');

            assert.equal(storedProofs().length, before);
            assert.equal(await ctx.mongoose.connection.db.collection('orders').countDocuments({ user_id: buyer.session.user.id }), 0);
        });

        it('409 si el total cambio respecto del que vio el usuario', async () => {
            const res = await checkout(buyer, { items: [{ product_id: 'p-guia' }], expected: 9 }).expect(409);
            assert.match(res.body.error.message, /S\/ 10\.00/);
        });

        let orderId;
        it('registra el pedido pendiente con el precio del servidor y el comprobante en la carpeta del monolito', async () => {
            const res = await checkout(buyer, {
                items: [{ product_id: 'p-examen', areas: ['A', 'C'] }, { product_id: 'p-unico' }],
                method: 'plin',
                expected: 8,
            }).expect(201);
            const order = res.body.data;
            orderId = order.id;

            assert.equal(order.status, 'pending');
            assert.equal(order.total, 8); // 4 (examen con descuento) + 4
            assert.equal(order.discount, 1);
            assert.equal(order.subtotal, 9);
            assert.equal(order.payment_method, 'plin');
            assert.equal(order.has_payment_proof, true);
            assert.equal('payment_proof' in order, false);
            assert.deepEqual(order.items.map((i) => [i.product_id, i.unit_price, i.quantity, i.areas.map((a) => a.abrev)]), [
                ['p-examen', 2.5, 1, ['A', 'C']],
                ['p-unico', 4, 1, ['I']],
            ]);

            const stored = await ctx.mongoose.connection.db.collection('orders').findOne({ _id: orderId });
            assert.match(stored.payment_proof, /^\/storage\/payment\/store\/[a-f0-9]+\.png$/);
            assert.equal(stored.user_id, buyer.session.user.id);
            assert.deepEqual(stored.items[0].areas.map((a) => a.abrev), ['A', 'C']);
            assert.ok(fs.existsSync(path.join(filesRoot, stored.payment_proof)));

            await settle();
            assert.ok(ctx.outbox.some((m) => m.to === buyer.email && m.template === 'api_order_received'));
            const admin = ctx.outbox.find((m) => m.to === 'admin@eduteka.test' && m.template === 'api_order_review');
            assert.equal(admin.data.order_id, orderId);

            const log = await eventually(() => ctx.mongoose.connection.db.collection('activitylogs').findOne({ action: 'store.order_created', target_id: orderId }));
            assert.equal(log.user_id, buyer.session.user.id);
            assert.equal(log.metadata.via, 'api');
        });

        it('un segundo envio identico en revision es un 409 (doble toque)', async () => {
            const res = await checkout(buyer, { items: [{ product_id: 'p-examen', areas: ['A', 'C'] }, { product_id: 'p-unico' }] }).expect(409);
            assert.match(res.body.error.message, /mismo importe/);
        });

        it('el pedido aparece en /pedidos y en /perfil/recursos (sin enlaces mientras esta pendiente)', async () => {
            const list = await request(ctx.app).get('/api/v1/pedidos').set(bearer(buyer)).expect(200);
            assert.deepEqual(list.body.data.map((o) => o.id), [orderId]);
            assert.equal(list.body.meta.total, 1);

            const filtered = await request(ctx.app).get('/api/v1/pedidos?status=verified').set(bearer(buyer)).expect(200);
            assert.equal(filtered.body.meta.total, 0);

            const detail = await request(ctx.app).get(`/api/v1/pedidos/${orderId}`).set(bearer(buyer)).expect(200);
            assert.equal(detail.body.data.total, 8);

            const resources = await request(ctx.app).get('/api/v1/perfil/recursos').set(bearer(buyer)).expect(200);
            const pending = resources.body.data.orders.find((o) => o.id === orderId);
            assert.equal(pending.status, 'pending');
            assert.ok(pending.items[0].files.every((f) => f.available === false && f.download_url === null));
        });

        it('el pedido ajeno es 404 y el rechazado muestra su motivo', async () => {
            await request(ctx.app).get(`/api/v1/pedidos/${orderId}`).set(bearer(other)).expect(404);
            const mine = await request(ctx.app).get('/api/v1/pedidos').set(bearer(other)).expect(200);
            assert.deepEqual(mine.body.data, []);

            await ctx.mongoose.connection.db.collection('orders').updateOne({ _id: orderId }, { $set: { status: 'rejected', status_reason: 'Monto no coincide', message: 'Envía otra captura' } });
            const res = await request(ctx.app).get(`/api/v1/pedidos/${orderId}`).set(bearer(buyer)).expect(200);
            assert.equal(res.body.data.status, 'rejected');
            assert.equal(res.body.data.status_reason, 'Monto no coincide');
            assert.equal(res.body.data.message, 'Envía otra captura');
        });
    });
});
