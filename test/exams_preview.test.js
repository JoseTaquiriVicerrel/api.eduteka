import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedExams } from './helpers/seed.js';

// Vista previa gratuita: sin suscripcion, solo la primera pregunta de cada cuadernillo.
describe('examenes: vista previa sin suscripcion', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ EXAM_PREVIEW_QUESTIONS: '1' });
        await seedCatalog(ctx);
        await seedExams(ctx);
    });
    after(() => ctx.stop());

    const get = (path, user) => request(ctx.app).get(`/api/v1/examenes${path}`).set(user ? bearer(user) : {});

    it('anonimo: solo la primera pregunta; la lectura que quedaria suelta se omite', async () => {
        const { data } = (await get('/unmsm-2025-i').expect(200)).body;

        assert.deepEqual(data.items.map((item) => item.id), ['g1']);
        assert.deepEqual(data.access, { preview: true, total_questions: 2, served_questions: 1 });
    });

    it('aplica a cada cuadernillo', async () => {
        const { data } = (await get('/unmsm-2025-i?area=B').expect(200)).body;
        assert.deepEqual(data.items.map((item) => item.id), ['g2']);
        assert.equal(data.access.preview, true);
    });

    it('un estudiante sin suscripcion tambien ve la vista previa', async () => {
        const student = await createUser(ctx);
        const { data } = (await get('/unmsm-2025-i', student).expect(200)).body;
        assert.equal(data.items.length, 1);
        assert.equal(data.access.preview, true);
    });

    it('con suscripcion vigente se ve completo', async () => {
        const premium = await createUser(ctx);
        await ctx.User.updateOne({ _id: premium.session.user.id }, {
            $set: { suscription: { status: 'activo', end_date: new Date(Date.now() + 86_400_000) } },
        });
        const { data } = (await get('/unmsm-2025-i', premium).expect(200)).body;
        assert.deepEqual(data.items.map((item) => item.id), ['g1', 'gr1', 'g2']);
        assert.deepEqual(data.access, { preview: false, total_questions: 2, served_questions: 2 });
    });

    it('una suscripcion vencida (cron pendiente) no da acceso completo', async () => {
        const expired = await createUser(ctx);
        await ctx.User.updateOne({ _id: expired.session.user.id }, {
            $set: { suscription: { status: 'activo', end_date: new Date(Date.now() - 1000) } },
        });
        const { data } = (await get('/unmsm-2025-i', expired).expect(200)).body;
        assert.equal(data.access.preview, true);
    });

    it('docentes y administradores ven el examen completo (es su material)', async () => {
        const teacher = await createUser(ctx, { account_type: 'Profesor' });
        const { data } = (await get('/unmsm-2025-i', teacher).expect(200)).body;
        assert.equal(data.items.length, 3);
        assert.equal(data.access.preview, false);
    });
});
