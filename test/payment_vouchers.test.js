import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Jimp from 'jimp-compact';
import request from 'supertest';
import { bootTestApp, eventually, settle } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedSimulacra } from './helpers/seed.js';

// Verificacion de comprobantes con IA (como la web): se aprueba solo si el numero de
// operacion es nuevo, el monto coincide y la fecha es reciente; si no, revision manual.

const DAY = 86_400_000;
// 'YYYY-MM-DD' en hora de Lima, `offset` dias atras.
const limaDay = (offset = 0) => new Date(Date.now() - 5 * 3_600_000 - offset * DAY).toISOString().slice(0, 10);

// Un solo arranque: la configuracion se lee una vez por proceso.
let ctx;
let filesRoot;
before(async () => {
    filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eduteka-vouchers-'));
    ctx = await bootTestApp({
        FILES_ROOT_DIR: filesRoot,
        PAY_CAPTURE_DIR: path.join(filesRoot, 'pay_capture'),
        ADMIN_EMAIL: 'admin@eduteka.test',
        PAYMENT_VOUCHER_MAX_AGE_DAYS: '3',
    });
});
after(async () => {
    await ctx.stop();
    fs.rmSync(filesRoot, { recursive: true, force: true });
});

describe('comprobantes: reglas', () => {
    let assessVoucher;
    let normalizeVoucher;
    let operationVariants;

    before(async () => {
        ({ assessVoucher, operationVariants } = await import('#Modules/payments/voucher.verify.js'));
        ({ normalizeVoucher } = await import('#Modules/payments/voucher.reader.js'));
    });

    const ok = (extra = {}) => ({ monto: 15, fecha: limaDay(0), numero_operacion: '123456', receptor: 'Eduteka', ...extra });
    const assess = (data, expected = 15) => assessVoucher(data, expected, { reused: false });

    it('aprueba solo con numero de operacion, monto y fecha correctos', async () => {
        assert.deepEqual(await assess(ok()), { approved: true, reason: null });
        // Margen de S/ 1 (la IA puede leer mal los centimos) y hasta 3 dias de antiguedad.
        assert.equal((await assess(ok({ monto: 15.5, fecha: limaDay(3) }))).approved, true);
    });

    it('cada fallo pasa a revision manual con su motivo', async () => {
        assert.equal((await assess(null)).reason, 'Falló verificación IA');
        assert.equal((await assess(ok({ numero_operacion: null }))).reason, 'No se pudo leer el número de operación');
        assert.equal((await assessVoucher(ok(), 15, { reused: true })).reason, 'El comprobante ya fue usado en otro pago o pedido');
        assert.equal((await assess(ok({ monto: null }))).reason, 'No se pudo detectar el monto');
        assert.equal((await assess(ok({ monto: 10 }))).reason, 'Monto no coincide: esperado 15.00 vs encontrado 10.00');
        assert.equal((await assess(ok({ fecha: null }))).reason, 'No se pudo leer la fecha del pago');
        assert.equal((await assess(ok({ fecha: '2026-02-31' }))).reason, 'No se pudo leer la fecha del pago');
        assert.match((await assess(ok({ fecha: limaDay(-1) }))).reason, /posterior a hoy/);
        assert.match((await assess(ok({ fecha: limaDay(4) }))).reason, /más de 3 días/);
    });

    it('normaliza la lectura de la IA', () => {
        assert.deepEqual(normalizeVoucher({ monto: 'S/ 15.00', fecha: ' 2026-10-01 ', receptor: 'null', numero_operacion: 123 }),
            { monto: 15, fecha: '2026-10-01', receptor: null, numero_operacion: '123' });
        assert.equal(normalizeVoucher({ monto: '1.250,50' }).monto, 1250.5);
        assert.equal(normalizeVoucher({ monto: '1,250.50' }).monto, 1250.5);
        assert.equal(normalizeVoucher({ monto: '15,00' }).monto, 15);
        assert.equal(normalizeVoucher('texto'), null);
    });

    it('el numero de operacion se busca en sus distintas formas', () => {
        assert.deepEqual(operationVariants(' 00123 456 '), ['00123 456', '00123456', 123456]);
    });

    it('detecta el mismo numero guardado con otros separadores', async () => {
        const { isVoucherReused } = await import('#Modules/payments/voucher.verify.js');
        await ctx.mongoose.connection.db.collection('orders').insertOne({ _id: 'o-sep', ai_analysis: { numero_operacion: 'Op. 0042-77' } });
        assert.equal(await isVoucherReused('004277'), true);
        assert.equal(await isVoucherReused('0042770'), false);
        await ctx.mongoose.connection.db.collection('payments').insertOne({ _id: 'p-num', ai_analysis: { numero_operacion: 88112233 } });
        assert.equal(await isVoucherReused('88 112 233'), true);
    });
});

describe('comprobantes: flujos', () => {
    let memoryReader;
    let png;
    const db = () => ctx.mongoose.connection.db;

    before(async () => {
        ({ memoryReader } = await import('#Modules/payments/voucher.reader.js'));
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
        await db().collection('products').insertOne({ _id: 'p-guia', name: 'Guía', slug: 'guia', type: 'Material', price: 10, state: true, files: [] });
        await db().collection('suscriptions').insertMany([
            { _id: 'plan-anual', name: '1 año', slug: 'anual', price: 60, duration_months: 12, state: true },
            { _id: 'plan-semestral', name: '6 meses', slug: 'semestral', price: 40, duration_months: 6, state: true },
        ]);
        png = await new Jimp(40, 40, 0x8844ccff).getBufferAsync(Jimp.MIME_PNG);
    });
    beforeEach(() => { memoryReader.next = null; });

    let operation = 900000;
    const voucher = (monto, extra = {}) => ({ monto, fecha: limaDay(0), receptor: 'Eduteka', numero_operacion: String((operation += 1)), ...extra });

    const checkout = (user) => request(ctx.app).post('/api/v1/tienda/checkout').set(bearer(user))
        .field('items', JSON.stringify([{ product_id: 'p-guia' }])).field('payment_method', 'yape')
        .attach('payment_proof', png, { filename: 'pago.png', contentType: 'image/png' });

    const subscribe = (user, slug = 'anual') => request(ctx.app).post(`/api/v1/suscripciones/${slug}/suscribirme`).set(bearer(user))
        .attach('payment_proof', png, { filename: 'pago.png', contentType: 'image/png' });

    describe('tienda', () => {
        it('comprobante valido: el pedido nace verificado y se puede descargar', async () => {
            const user = await createUser(ctx);
            memoryReader.next = voucher(10);
            const res = await checkout(user).expect(201);
            assert.equal(res.body.data.status, 'verified');
            assert.equal('ai_analysis' in res.body.data, false);

            const stored = await db().collection('orders').findOne({ _id: res.body.data.id });
            assert.equal(stored.ai_analysis.numero_operacion, String(operation));
            assert.equal(stored.status_reason, undefined);

            await settle();
            assert.ok(ctx.outbox.some((m) => m.to === user.email && m.subject === '¡Compra exitosa!' && m.data.verified === true));
            assert.ok(ctx.outbox.some((m) => m.to === 'admin@eduteka.test' && m.subject === 'Pedido verificado automáticamente'));
            const log = await eventually(() => db().collection('activitylogs').findOne({ target_id: res.body.data.id }));
            assert.equal(log.metadata.order_status, 'verified');
        });

        it('monto distinto o IA sin lectura: queda pendiente con el motivo solo para el administrador', async () => {
            const user = await createUser(ctx);
            memoryReader.next = voucher(5);
            const res = await checkout(user).expect(201);
            assert.equal(res.body.data.status, 'pending');
            assert.equal(res.body.data.status_reason, null);
            const stored = await db().collection('orders').findOne({ _id: res.body.data.id });
            assert.equal(stored.status_reason, 'Monto no coincide: esperado 10.00 vs encontrado 5.00');
            await settle();
            assert.ok(ctx.outbox.some((m) => m.data?.order_id === res.body.data.id && m.data.reason === stored.status_reason));

            const other = await createUser(ctx);
            memoryReader.next = null; // la IA no devolvio nada
            const failed = await checkout(other).expect(201);
            assert.equal((await db().collection('orders').findOne({ _id: failed.body.data.id })).status_reason, 'Falló verificación IA');
        });

        it('un comprobante ya usado (aunque con otro formato) no se aprueba dos veces', async () => {
            const first = await createUser(ctx);
            memoryReader.next = voucher(10, { numero_operacion: '00777 001' });
            assert.equal((await checkout(first).expect(201)).body.data.status, 'verified');

            const second = await createUser(ctx);
            memoryReader.next = voucher(10, { numero_operacion: '00777001' });
            const res = await checkout(second).expect(201);
            assert.equal(res.body.data.status, 'pending');
            assert.equal((await db().collection('orders').findOne({ _id: res.body.data.id })).status_reason, 'El comprobante ya fue usado en otro pago o pedido');
        });

        it('dos envios simultaneos del mismo comprobante: solo uno se aprueba', async () => {
            const [a, b] = await Promise.all([createUser(ctx), createUser(ctx)]);
            memoryReader.next = voucher(10, { numero_operacion: '555000111' });
            const results = await Promise.all([checkout(a).expect(201), checkout(b).expect(201)]);
            assert.deepEqual(results.map((r) => r.body.data.status).sort(), ['pending', 'verified']);
        });

        it('un doble toque tras un pedido ya verificado es 409', async () => {
            const user = await createUser(ctx);
            memoryReader.next = voucher(10);
            await checkout(user).expect(201);
            memoryReader.next = voucher(10);
            await checkout(user).expect(409);
        });
    });

    describe('suscripciones', () => {
        it('comprobante valido: pago Completo y plan activo en el acto', async () => {
            const user = await createUser(ctx);
            memoryReader.next = voucher(60);
            const res = await subscribe(user).expect(201);
            const { data } = res.body;
            assert.equal(data.status, 'paid');
            assert.equal(data.subscription.active, true);
            assert.equal(data.subscription.name, '1 año');

            const payment = await db().collection('payments').findOne({ _id: data.id });
            assert.equal(payment.status, 'Completo');
            assert.ok(payment.payment_date);

            const doc = await ctx.User.findById(user.session.user.id).lean();
            assert.equal(doc.suscription.status, 'activo');
            const months = (new Date(doc.suscription.end_date) - new Date(doc.suscription.start_date)) / (30 * DAY);
            assert.ok(months > 11.5 && months < 12.5);
            assert.ok(doc.suscription.start_date_on);
            assert.equal(doc.notification_subscription_expiration, false);

            await settle();
            assert.ok(ctx.outbox.some((m) => m.to === user.email && m.template === 'email_verification_suscription'));
            assert.equal(ctx.outbox.some((m) => m.data?.payment_id === data.id), false); // nada que revisar

            const status = await request(ctx.app).get('/api/v1/suscripciones/estado').set(bearer(user)).expect(200);
            assert.equal(status.body.data.state, 'active');
        });

        it('renovacion aprobada: el periodo nuevo se encadena al vigente y el ciclo anterior va al historial', async () => {
            const user = await createUser(ctx);
            const end = new Date(Date.now() + 20 * DAY);
            await ctx.User.updateOne({ _id: user.session.user.id }, { $set: { suscription: { name: '6 meses', status: 'activo', start_date: new Date(Date.now() - 160 * DAY), end_date: end } } });
            await db().collection('payments').insertOne({ _id: 'pago-anterior', user_id: user.session.user.id, status: 'Completado', amount: 40, transaction_type: 'Compra', created_at: new Date(Date.now() - 160 * DAY) });

            memoryReader.next = voucher(40);
            const res = await subscribe(user, 'semestral').expect(201);
            assert.equal(res.body.data.transaction_type, 'Renovar');

            const doc = await ctx.User.findById(user.session.user.id).lean();
            assert.equal(new Date(doc.suscription.start_date).getTime(), end.getTime());
            assert.equal(doc.suscription_history.length, 1);
            assert.equal(doc.suscription_history[0].payment_id, 'pago-anterior');
        });

        it('comprobante ya usado en un pedido: el pago queda pendiente', async () => {
            const buyer = await createUser(ctx);
            memoryReader.next = voucher(10, { numero_operacion: '424242' });
            await checkout(buyer).expect(201);

            const user = await createUser(ctx);
            memoryReader.next = voucher(60, { numero_operacion: '424242' });
            const res = await subscribe(user).expect(201);
            assert.equal(res.body.data.status, 'pending');
            assert.equal(res.body.data.subscription, null);
            const payment = await db().collection('payments').findOne({ _id: res.body.data.id });
            assert.equal(payment.status, 'Pendiente');
            assert.equal(payment.status_reason, 'El comprobante ya fue usado en otro pago o pedido');
            assert.equal((await ctx.User.findById(user.session.user.id).lean()).suscription, undefined);
        });

        it('fecha antigua: pendiente', async () => {
            const user = await createUser(ctx);
            memoryReader.next = voucher(60, { fecha: limaDay(10) });
            const res = await subscribe(user).expect(201);
            assert.equal(res.body.data.status, 'pending');
            assert.match((await db().collection('payments').findOne({ _id: res.body.data.id })).status_reason, /más de 3 días/);
        });
    });

    describe('simulacros', () => {
        const enroll = (user) => request(ctx.app).post('/api/v1/simulacros/simulacro-pago/inscribirme').set(bearer(user))
            .field('fullname', 'Ana Pérez López').field('dni', '12345678')
            .attach('screenshot', png, { filename: 'pago.png', contentType: 'image/png' });

        it('comprobante valido: la inscripcion queda verificada', async () => {
            const user = await createUser(ctx);
            memoryReader.next = voucher(15);
            const res = await enroll(user).expect(201);
            assert.equal(res.body.data.verified, true);
            assert.equal(res.body.data.status_reason, null);
            await settle();
            assert.ok(ctx.outbox.some((m) => m.to === user.email && m.template === 'api_simulacrum_enrolled' && m.data.verified === true));
        });

        it('comprobante reutilizado: pendiente, con el motivo interno solo en la base', async () => {
            const buyer = await createUser(ctx);
            memoryReader.next = voucher(10, { numero_operacion: '313131' });
            await checkout(buyer).expect(201);

            const user = await createUser(ctx);
            memoryReader.next = voucher(15, { numero_operacion: '313131' });
            const res = await enroll(user).expect(201);
            assert.equal(res.body.data.verified, false);
            assert.equal(res.body.data.status_reason, 'Pendiente de verificación');
            const stored = await db().collection('usersimulacrums').findOne({ _id: res.body.data.id });
            assert.equal(stored.status_reason, 'El comprobante ya fue usado en otro pago o pedido');
            assert.equal(stored.ai_analysis.numero_operacion, '313131');
        });
    });
});
