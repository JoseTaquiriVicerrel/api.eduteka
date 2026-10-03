import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Jimp from 'jimp-compact';
import request from 'supertest';
import { bootTestApp, eventually, settle } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

const DAY = 86_400_000;

async function seedPlans(ctx) {
    await ctx.mongoose.connection.db.collection('suscriptions').insertMany([
        { _id: 'plan-anual', name: '1 año', slug: 'anual', price: 60, duration_months: 12, duration_days: 365, state: true, description: 'Todo el año' },
        { _id: 'plan-semestral', name: '6 meses', slug: 'semestral', price: 40, duration_months: 6, duration_days: 180, state: true },
        // Mas barato por mes, pero restringido: no compite por "mejor precio".
        { _id: 'plan-inst', name: 'Institucional', slug: 'institucional', price: 15, duration_months: 6, state: true, restricted_to_institution: true },
        { _id: 'plan-viejo', name: 'Plan viejo', slug: 'viejo', price: 5, duration_months: 1, state: false },
    ]);
}

describe('suscripciones', () => {
    let ctx;
    let filesRoot;
    let png;

    before(async () => {
        filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eduteka-subs-'));
        ctx = await bootTestApp({ FILES_ROOT_DIR: filesRoot, ADMIN_EMAIL: 'admin@eduteka.test' });
        await seedCatalog(ctx); // inst-unmsm (12 examenes), inst-antigua (2)
        await seedPlans(ctx);
        png = await new Jimp(60, 60, 0x2266aaff).getBufferAsync(Jimp.MIME_PNG);
    });
    after(async () => {
        await ctx.stop();
        fs.rmSync(filesRoot, { recursive: true, force: true });
    });

    const payments = () => ctx.mongoose.connection.db.collection('payments');
    const setPlan = (user, suscription) => ctx.User.updateOne({ _id: user.session.user.id }, { $set: { suscription } });

    const pay = (user, route, { method, institution, proof = png, field = 'payment_proof' } = {}) => {
        const req = request(ctx.app).post(`/api/v1/suscripciones${route}`).set(bearer(user));
        if (method) req.field('payment_method', method);
        if (institution) req.field('institution_id', institution);
        if (proof) req.attach(field, proof, { filename: 'pago.png', contentType: 'image/png' });
        return req;
    };

    describe('catalogo', () => {
        it('lista los planes a la venta por precio, con precio mensual y el mejor plan general', async () => {
            const res = await request(ctx.app).get('/api/v1/suscripciones').expect(200);
            const plans = res.body.data;
            assert.deepEqual(plans.map((p) => p.slug), ['institucional', 'semestral', 'anual']);
            const anual = plans.find((p) => p.slug === 'anual');
            assert.equal(anual.per_month, 5);
            assert.equal(anual.best_value, true);
            assert.equal(plans.find((p) => p.slug === 'institucional').best_value, false);
            assert.ok(plans.every((p) => p.is_current === false && p.currency === 'PEN'));
        });

        it('con sesion marca el plan actual', async () => {
            const user = await createUser(ctx);
            await setPlan(user, { name: '6 meses', status: 'activo', end_date: new Date(Date.now() + 30 * DAY) });
            const res = await request(ctx.app).get('/api/v1/suscripciones').set(bearer(user)).expect(200);
            assert.deepEqual(res.body.data.filter((p) => p.is_current).map((p) => p.slug), ['semestral']);
        });

        it('el detalle de un plan restringido lista solo instituciones elegibles; uno inactivo es 404', async () => {
            const res = await request(ctx.app).get('/api/v1/suscripciones/institucional').expect(200);
            assert.deepEqual(res.body.data.institutions.map((i) => i.id), ['inst-unmsm']);
            assert.equal(res.body.data.min_exams_institution, 10);
            assert.equal(res.body.data.pending_payment, null);
            assert.equal(res.body.data.renewal, null);

            const general = await request(ctx.app).get('/api/v1/suscripciones/anual').expect(200);
            assert.equal(general.body.data.institutions, null);

            await request(ctx.app).get('/api/v1/suscripciones/viejo').expect(404);
        });

        it('el detalle con sesion avisa desde cuando correria la renovacion', async () => {
            const user = await createUser(ctx);
            const end = new Date(Date.now() + 10 * DAY);
            await setPlan(user, { name: '1 año', status: 'activo', end_date: end });
            const res = await request(ctx.app).get('/api/v1/suscripciones/anual').set(bearer(user)).expect(200);
            assert.deepEqual(res.body.data.renewal, {
                current_plan: '1 año', same_plan: true, running: true, current_end_date: end.toISOString(), starts_at: end.toISOString(),
            });
        });
    });

    describe('pago con comprobante', () => {
        it('exige sesion y comprobante', async () => {
            await request(ctx.app).post('/api/v1/suscripciones/anual/suscribirme').expect(401);
            const user = await createUser(ctx);
            const res = await pay(user, '/anual/suscribirme', { proof: null }).expect(422);
            assert.equal(res.body.error.details[0].field, 'payment_proof');
            await pay(user, '/viejo/suscribirme').expect(404);
            await pay(user, '/anual/suscribirme', { method: 'tarjeta' }).expect(422);
        });

        it('el plan restringido exige una institucion elegible', async () => {
            const user = await createUser(ctx);
            const missing = await pay(user, '/institucional/suscribirme').expect(422);
            assert.equal(missing.body.error.details[0].field, 'institution_id');
            const small = await pay(user, '/institucional/suscribirme', { institution: 'inst-antigua' }).expect(422);
            assert.match(small.body.error.details[0].message, /10 o más exámenes/);
            assert.equal(await payments().countDocuments({ user_id: user.session.user.id }), 0);
        });

        it('registra una compra pendiente, guarda el comprobante y avisa; un segundo pago espera', async () => {
            const user = await createUser(ctx);
            const res = await pay(user, '/institucional/suscribirme', { method: 'plin', institution: 'inst-unmsm', field: 'payment_capture' }).expect(201);
            const payment = res.body.data;
            assert.equal(payment.status, 'pending');
            assert.equal(payment.amount, 15);
            assert.equal(payment.payment_method, 'Plin');
            assert.equal(payment.transaction_type, 'Compra');
            assert.equal(payment.institution_id, 'inst-unmsm');
            assert.deepEqual(payment.plan, { id: 'plan-inst', name: 'Institucional', slug: 'institucional' });

            const stored = await payments().findOne({ _id: payment.id });
            assert.equal(stored.status, 'Pendiente');
            assert.equal(stored.subscription_id, 'plan-inst');
            assert.match(stored.payment_capture, /^\/storage\/payment\/suscriptions\/[a-f0-9]+\.png$/);
            assert.ok(fs.existsSync(path.join(filesRoot, stored.payment_capture)));
            assert.equal(JSON.stringify(res.body).includes(stored.payment_capture), false);

            const doc = await ctx.User.findById(user.session.user.id, { university: 1, suscription: 1 }).lean();
            assert.equal(doc.university, 'inst-unmsm');
            // El plan no se activa: lo hace el administrador al aprobar el pago.
            assert.equal(doc.suscription?.status, undefined);

            await settle();
            assert.ok(ctx.outbox.some((m) => m.to === user.email && m.template === 'api_subscription_payment_received'));
            assert.ok(ctx.outbox.some((m) => m.to === 'admin@eduteka.test' && m.data.payment_id === payment.id));
            const log = await eventually(() => ctx.mongoose.connection.db.collection('activitylogs').findOne({ target_id: payment.id }));
            assert.equal(log.action, 'subscription.purchase_requested');

            const again = await pay(user, '/anual/suscribirme').expect(409);
            assert.match(again.body.error.message, /en revisión/);

            const detail = await request(ctx.app).get('/api/v1/suscripciones/anual').set(bearer(user)).expect(200);
            assert.equal(detail.body.data.pending_payment.id, payment.id);
        });

        it('con plan previo el pago es Renovar (mismo plan) o Actualizar (otro plan)', async () => {
            const renewing = await createUser(ctx);
            await setPlan(renewing, { name: '6 meses', status: 'Finalizado', end_date: new Date(Date.now() - DAY) });
            const renewed = await pay(renewing, '/semestral/suscribirme').expect(201);
            assert.equal(renewed.body.data.transaction_type, 'Renovar');
            assert.equal(renewed.body.data.payment_method, 'Yape');

            const upgrading = await createUser(ctx);
            await setPlan(upgrading, { name: '6 meses', status: 'activo', end_date: new Date(Date.now() + DAY) });
            const upgraded = await pay(upgrading, '/anual/suscribirme').expect(201);
            assert.equal(upgraded.body.data.transaction_type, 'Actualizar');
            const log = await eventually(() => ctx.mongoose.connection.db.collection('activitylogs').findOne({ target_id: upgraded.body.data.id }));
            assert.equal(log.action, 'subscription.renewal_requested');
        });

        it('/renovar paga el plan actual; sin plan o con el plan retirado es 409', async () => {
            const none = await createUser(ctx);
            const noPlan = await pay(none, '/renovar').expect(409);
            assert.match(noPlan.body.error.message, /No tienes un plan/);

            const retired = await createUser(ctx);
            await setPlan(retired, { name: 'Plan viejo', status: 'activo' });
            await pay(retired, '/renovar').expect(409);

            // Plan institucional: si no elige otra, se renueva con la institucion que ya tiene.
            const inst = await createUser(ctx);
            await setPlan(inst, { name: 'Institucional', status: 'activo', restricted_to_institution: true, institution_id: 'inst-unmsm', end_date: new Date(Date.now() + DAY) });
            const res = await pay(inst, '/renovar').expect(201);
            assert.equal(res.body.data.transaction_type, 'Renovar');
            assert.equal(res.body.data.institution_id, 'inst-unmsm');
        });
    });

    describe('estado', () => {
        const status = (user) => request(ctx.app).get('/api/v1/suscripciones/estado').set(bearer(user)).expect(200);

        it('sin pagos ni plan: none; con plan asignado a mano: active', async () => {
            const user = await createUser(ctx);
            assert.equal((await status(user)).body.data.state, 'none');
            await setPlan(user, { name: '1 año', status: 'activo', end_date: new Date(Date.now() + DAY) });
            const res = await status(user);
            assert.equal(res.body.data.state, 'active');
            assert.equal(res.body.data.last_payment, null);
            assert.equal(res.body.data.subscription.active, true);
        });

        it('sigue el ultimo pago: pendiente, rechazado con motivo, pagado y vencido', async () => {
            const user = await createUser(ctx);
            const { id } = (await pay(user, '/anual/suscribirme').expect(201)).body.data;
            assert.equal((await status(user)).body.data.state, 'pending');

            await payments().updateOne({ _id: id }, { $set: { status: 'Cancelado', message: 'La captura no se lee', status_reason: 'interno' } });
            const rejected = (await status(user)).body.data;
            assert.equal(rejected.state, 'rejected');
            assert.equal(rejected.last_payment.status, 'rejected');
            assert.equal(rejected.last_payment.reason, 'La captura no se lee');

            await payments().updateOne({ _id: id }, { $set: { status: 'Completado' } });
            await setPlan(user, { name: '1 año', status: 'activo', end_date: new Date(Date.now() + DAY) });
            assert.equal((await status(user)).body.data.state, 'active');

            await setPlan(user, { name: '1 año', status: 'activo', end_date: new Date(Date.now() - DAY) });
            const expired = (await status(user)).body.data;
            assert.equal(expired.state, 'expired');
            assert.equal(expired.last_payment.reason, null);
        });
    });
});
