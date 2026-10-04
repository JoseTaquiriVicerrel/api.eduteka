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
        // Exclusivos por tipo de cuenta.
        { _id: 'plan-docente', name: 'Docente Anual', slug: 'docente-anual', price: 90, duration_months: 12, state: true, audience: 'Profesor', benefits: ['Exámenes en PDF para tus clases'], limits: { list_questions: 80, materials: 60 } },
        { _id: 'plan-est', name: 'Estudiante Mensual', slug: 'estudiante-mensual', price: 10, duration_months: 1, state: true, audience: 'Estudiante' },
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
        const catalog = (user) => {
            const req = request(ctx.app).get('/api/v1/suscripciones');
            return (user ? req.set(bearer(user)) : req).expect(200).then((res) => res.body.data);
        };

        it('visitante: ambas pestanas; un plan Todos sale en las dos; mejor precio por mes dentro de cada una', async () => {
            const data = await catalog();
            assert.deepEqual(data.tabs, ['Estudiante', 'Profesor']);
            assert.equal(data.default_tab, 'Estudiante');
            assert.equal(data.plans, null);
            assert.deepEqual(data.student.map((p) => p.slug), ['estudiante-mensual', 'institucional', 'semestral', 'anual']);
            assert.deepEqual(data.teacher.map((p) => p.slug), ['institucional', 'semestral', 'anual', 'docente-anual']);

            const anual = data.student.find((p) => p.slug === 'anual');
            assert.equal(anual.per_month, 5);
            assert.equal(anual.best_value, true);
            assert.equal(anual.currency, 'PEN');
            assert.equal(data.student.find((p) => p.slug === 'institucional').best_value, false);
            assert.equal(data.teacher.find((p) => p.slug === 'docente-anual').best_value, false);
            assert.equal(data.teacher.find((p) => p.slug === 'anual').best_value, true);

            const docente = data.teacher.find((p) => p.slug === 'docente-anual');
            assert.equal(docente.audience, 'Profesor');
            assert.deepEqual(docente.benefits, ['Exámenes en PDF para tus clases']);
            assert.equal(docente.per_month, 7.5);
            assert.equal(anual.audience, 'Todos');
            assert.ok([...data.student, ...data.teacher].every((p) => p.is_current === false));
        });

        it('con sesion cada tipo de cuenta ve solo el suyo (mas los Todos); el administrador tambien ve solo el de su cuenta', async () => {
            const student = await catalog(await createUser(ctx));
            assert.deepEqual(student.tabs, ['Estudiante']);
            assert.deepEqual(student.teacher, []);
            assert.deepEqual(student.plans, student.student);
            assert.ok(!student.student.some((p) => p.audience === 'Profesor'));

            const teacher = await catalog(await createUser(ctx, { account_type: 'Profesor', teaching_area: 'area-lenguaje' }));
            assert.deepEqual(teacher.tabs, ['Profesor']);
            assert.equal(teacher.default_tab, 'Profesor');
            assert.deepEqual(teacher.student, []);
            assert.deepEqual(teacher.plans, teacher.teacher);
            assert.deepEqual(teacher.teacher.map((p) => p.slug), ['institucional', 'semestral', 'anual', 'docente-anual']);

            const admin = await createUser(ctx);
            await ctx.User.updateOne({ _id: admin.session.user.id }, { $set: { rol: 'Administrador' } });
            const adminCatalog = await catalog(admin);
            assert.deepEqual(adminCatalog.tabs, ['Estudiante']);
            assert.deepEqual(adminCatalog.teacher, []);
        });

        it('abrir o comprar un plan de otra audiencia es 404, tambien escribiendo el slug; el visitante lo puede abrir', async () => {
            const student = await createUser(ctx);
            const teacher = await createUser(ctx, { account_type: 'Profesor', teaching_area: 'area-lenguaje' });

            await request(ctx.app).get('/api/v1/suscripciones/docente-anual').set(bearer(student)).expect(404);
            await pay(student, '/docente-anual/suscribirme').expect(404);
            await request(ctx.app).get('/api/v1/suscripciones/estudiante-mensual').set(bearer(teacher)).expect(404);
            await pay(teacher, '/estudiante-mensual/suscribirme').expect(404);
            assert.equal(await payments().countDocuments({ user_id: { $in: [student.session.user.id, teacher.session.user.id] } }), 0);

            const visitor = await request(ctx.app).get('/api/v1/suscripciones/docente-anual').expect(200);
            assert.equal(visitor.body.data.audience, 'Profesor');
            await request(ctx.app).get('/api/v1/suscripciones/docente-anual').set(bearer(teacher)).expect(200);
        });

        it('con sesion marca el plan actual', async () => {
            const user = await createUser(ctx);
            await setPlan(user, { name: '6 meses', status: 'activo', end_date: new Date(Date.now() + 30 * DAY) });
            const data = await catalog(user);
            assert.deepEqual(data.student.filter((p) => p.is_current).map((p) => p.slug), ['semestral']);
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
            assert.equal(again.body.error.code, 'PAYMENT_PENDING');
            assert.match(again.body.error.message, /en revisión/);
            assert.equal(await payments().countDocuments({ user_id: user.session.user.id }), 1);

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

        it('/renovar ya no existe: renovar es pagar otra vez el plan', async () => {
            const user = await createUser(ctx);
            await pay(user, '/renovar').expect(404);

            // Plan institucional: si no elige otra, se renueva con la institucion que ya tiene.
            const inst = await createUser(ctx);
            await setPlan(inst, { name: 'Institucional', status: 'activo', restricted_to_institution: true, institution_id: 'inst-unmsm', end_date: new Date(Date.now() + DAY) });
            const res = await pay(inst, '/institucional/suscribirme').expect(201);
            assert.equal(res.body.data.transaction_type, 'Renovar');
            assert.equal(res.body.data.institution_id, 'inst-unmsm');
        });

        it('solo una renovación a la vez: con una ya aprobada que no empieza, suscribirme responde 409 y can_renew es false', async () => {
            const user = await createUser(ctx);
            // Renovación aprobada y encadenada: el ciclo vigente es el nuevo y empieza dentro de 30 días.
            await setPlan(user, { name: '6 meses', status: 'activo', start_date: new Date(Date.now() + 30 * DAY), end_date: new Date(Date.now() + 210 * DAY) });

            const me = await request(ctx.app).get('/api/v1/auth/me').set(bearer(user)).expect(200);
            assert.equal(me.body.data.suscription.can_renew, false);
            const status = await request(ctx.app).get('/api/v1/suscripciones/estado').set(bearer(user)).expect(200);
            assert.equal(status.body.data.subscription.can_renew, false);

            // Mismo plan (Renovar) y otro plan (Actualizar) se encadenarían igual: ninguno se admite.
            for (const route of ['/semestral/suscribirme', '/anual/suscribirme']) {
                const res = await pay(user, route).expect(409);
                assert.equal(res.body.error.code, 'RENEWAL_ALREADY_QUEUED');
            }
            assert.equal(await payments().countDocuments({ user_id: user.session.user.id }), 0);
        });

        it('con el ciclo ya en marcha (start_date pasada) se puede renovar y can_renew es true', async () => {
            const user = await createUser(ctx);
            await setPlan(user, { name: '6 meses', status: 'activo', start_date: new Date(Date.now() - 30 * DAY), end_date: new Date(Date.now() + 150 * DAY) });

            const me = await request(ctx.app).get('/api/v1/auth/me').set(bearer(user)).expect(200);
            assert.equal(me.body.data.suscription.can_renew, true);
            const res = await pay(user, '/semestral/suscribirme').expect(201);
            assert.equal(res.body.data.transaction_type, 'Renovar');
        });

        it('Idempotency-Key: un reintento devuelve el primer resultado y no crea otro pago', async () => {
            const user = await createUser(ctx);
            const send = (key) => pay(user, '/anual/suscribirme').set('Idempotency-Key', key);
            const first = await send('intento-0001-abcd').expect(201);
            const retry = await send('intento-0001-abcd').expect(201);
            assert.equal(retry.body.data.id, first.body.data.id);
            assert.equal(await payments().countDocuments({ user_id: user.session.user.id }), 1);

            // Otra clave ya es otro intento: choca con el pago en revision.
            const other = await send('intento-0002-abcd').expect(409);
            assert.equal(other.body.error.code, 'PAYMENT_PENDING');

            const invalid = await send('corta').expect(422);
            assert.equal(invalid.body.error.details[0].field, 'Idempotency-Key');
        });

        it('al activar el plan se copian audience y limits al usuario (y de ahi salen los plan_limits)', async () => {
            const { activateSubscription } = await import('../src/modules/subscriptions/subscription.activation.js');
            const teacher = await createUser(ctx, { account_type: 'Profesor', teaching_area: 'area-lenguaje' });
            const plan = await ctx.mongoose.connection.db.collection('suscriptions').findOne({ _id: 'plan-docente' });
            const suscription = await activateSubscription({ userId: teacher.session.user.id, payment: { _id: 'pago-x', transaction_type: 'Compra' }, plan });
            assert.equal(suscription.audience, 'Profesor');
            assert.deepEqual(suscription.limits, { list_questions: 80, materials: 60 });

            const me = await request(ctx.app).get('/api/v1/auth/me').set(bearer(teacher)).expect(200);
            assert.deepEqual(me.body.data.plan_limits, { list_questions: 80, materials: 60, templates: 10 });
            assert.equal(me.body.data.suscription.audience, 'Profesor');

            // Editar el plan despues no cambia lo que ya tiene el suscriptor.
            await ctx.mongoose.connection.db.collection('suscriptions').updateOne({ _id: 'plan-docente' }, { $set: { limits: { list_questions: 5 } } });
            const again = await request(ctx.app).get('/api/v1/auth/me').set(bearer(teacher)).expect(200);
            assert.equal(again.body.data.plan_limits.list_questions, 80);
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
