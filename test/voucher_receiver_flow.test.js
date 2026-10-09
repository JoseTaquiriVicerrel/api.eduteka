import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Jimp from 'jimp-compact';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

// Con titular de Yape y limite de aprobacion automatica configurados, un comprobante real
// pagado a OTRA persona, o de un monto alto, no activa nada solo: queda pendiente para que
// lo revise un administrador. La configuracion se lee una vez por proceso: archivo propio.

const limaDay = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

let ctx;
let filesRoot;
let memoryReader;
let png;
const db = () => ctx.mongoose.connection.db;

before(async () => {
    filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eduteka-receiver-'));
    ctx = await bootTestApp({
        FILES_ROOT_DIR: filesRoot,
        PAY_CAPTURE_DIR: path.join(filesRoot, 'pay_capture'),
        PAYMENT_YAPE_NUMBER: '931 988 077',
        PAYMENT_YAPE_HOLDER: 'Eduteka Pagos',
        PAYMENT_AUTO_APPROVE_MAX_AMOUNT: '50',
    });
    ({ memoryReader } = await import('#Modules/payments/voucher.reader.js'));
    await seedCatalog(ctx);
    await db().collection('products').insertMany([
        { _id: 'p-guia', name: 'Guía', slug: 'guia', type: 'Material', price: 10, state: true, files: [] },
        { _id: 'p-pack', name: 'Pack', slug: 'pack', type: 'Material', price: 80, state: true, files: [] },
    ]);
    await db().collection('suscriptions').insertOne({ _id: 'plan-anual', name: '1 año', slug: 'anual', price: 60, duration_months: 12, state: true });
    png = await new Jimp(40, 40, 0x8844ccff).getBufferAsync(Jimp.MIME_PNG);
});
after(async () => {
    await ctx.stop();
    fs.rmSync(filesRoot, { recursive: true, force: true });
});
beforeEach(() => { memoryReader.next = null; });

let operation = 700000;
const voucher = (monto, extra = {}) => ({ monto, fecha: limaDay(), receptor: 'Eduteka P.', numero_operacion: String((operation += 1)), ...extra });

const checkout = (user, productId) => request(ctx.app).post('/api/v1/tienda/checkout').set(bearer(user))
    .field('items', JSON.stringify([{ product_id: productId }])).field('payment_method', 'yape')
    .attach('payment_proof', png, { filename: 'pago.png', contentType: 'image/png' });

const subscribe = (user) => request(ctx.app).post('/api/v1/suscripciones/anual/suscribirme').set(bearer(user))
    .attach('payment_proof', png, { filename: 'pago.png', contentType: 'image/png' });

describe('pagos: destinatario y monto alto en los flujos', () => {
    it('tienda: el destinatario correcto (aunque abreviado) se aprueba', async () => {
        const user = await createUser(ctx);
        memoryReader.next = voucher(10);
        const res = await checkout(user, 'p-guia').expect(201);
        assert.equal(res.body.data.status, 'verified');
    });

    it('tienda: un comprobante pagado a otra persona queda pendiente con el motivo solo en la base', async () => {
        const user = await createUser(ctx);
        memoryReader.next = voucher(10, { receptor: 'Maria Lopez Quispe' });
        const res = await checkout(user, 'p-guia').expect(201);

        assert.equal(res.body.data.status, 'pending');
        assert.equal(res.body.data.status_reason, null, 'el cliente no ve el motivo interno');
        const stored = await db().collection('orders').findOne({ _id: res.body.data.id });
        assert.equal(stored.status_reason, 'El destinatario del comprobante (Maria Lopez Quispe) no coincide con el titular de pago');
    });

    it('tienda: el destinatario se puede reconocer por los digitos del numero', async () => {
        const user = await createUser(ctx);
        memoryReader.next = voucher(10, { receptor: '*** *** 077' });
        assert.equal((await checkout(user, 'p-guia').expect(201)).body.data.status, 'verified');
    });

    it('tienda: un monto por encima del limite no se aprueba solo aunque todo cuadre', async () => {
        const user = await createUser(ctx);
        memoryReader.next = voucher(80);
        const res = await checkout(user, 'p-pack').expect(201);
        assert.equal(res.body.data.status, 'pending');
        const stored = await db().collection('orders').findOne({ _id: res.body.data.id });
        assert.match(stored.status_reason, /^Monto alto \(S\/ 80\.00\)/);
    });

    it('suscripcion: un monto alto deja el pago Pendiente y el plan sin activar', async () => {
        const high = await createUser(ctx);
        memoryReader.next = voucher(60);
        await subscribe(high).expect(201);
        const payment = await db().collection('payments').findOne({ user_id: high.session.user.id });
        assert.equal(payment.status, 'Pendiente');
        assert.match(payment.status_reason, /Monto alto/);
        const user = await ctx.User.findById(high.session.user.id).lean();
        assert.notEqual(user.suscription?.status, 'activo');
    });

    it('cuando la IA no devuelve nada, sigue siendo revision manual', async () => {
        const user = await createUser(ctx);
        memoryReader.next = null;
        const res = await checkout(user, 'p-guia').expect(201);
        assert.equal(res.body.data.status, 'pending');
    });
});

