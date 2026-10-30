import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedExams } from './helpers/seed.js';

const banner = (id, extra = {}) => ({
    _id: id, title: `Banner ${id}`, image: `/uploads/banners/${id}.png`, link_url: '/suscripciones', new_tab: false,
    placements: ['exam_sidebar'], audiences: [], institution_ids: [], start_at: null, end_at: null, order: 0, active: true, clicks: 0,
    created_at: new Date(), ...extra,
});

// Lo que rodea al detalle de un examen en la web: banners, promo de suscripcion y relacionados.
describe('examenes: extras del detalle (banners, promo, relacionados)', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        await seedExams(ctx);
        const db = ctx.mongoose.connection.db;
        await db.collection('banners').insertMany([
            banner('b-todos'),
            banner('b-unmsm', { institution_ids: ['inst-unmsm'], order: 1 }),
            banner('b-otra', { institution_ids: ['inst-antigua'] }),
            banner('b-vencido', { end_at: new Date(Date.now() - 60_000) }),
            banner('b-apagado', { active: false }),
            banner('b-suscriptores', { audiences: ['student_subscribed'] }),
            banner('b-home', { placements: ['home_hero'] }),
        ]);
        await db.collection('suscriptions').insertMany([
            { _id: 'plan-inst', name: 'Semestral institucional', slug: 'semestral-institucional', price: 15, state: true, restricted_to_institution: true },
            { _id: 'plan-docente', name: 'Docente', slug: 'docente-inst', price: 5, state: true, restricted_to_institution: true, audience: 'Profesor' },
        ]);
    });
    after(() => ctx.stop());

    const get = (id, user) => request(ctx.app).get(`/api/v1/examenes/${id}/extras`).set(user ? bearer(user) : {});

    it('visitante: solo banners vigentes, de su publico y de la institucion del examen', async () => {
        const { data } = (await get('e1').expect(200)).body;
        assert.deepEqual(data.banners.banners.map((item) => item.title), ['Banner b-todos', 'Banner b-unmsm']);
        assert.equal(data.banners.ratio, '1 / 1');
        const first = data.banners.banners[0];
        assert.equal(first.image, 'https://eduteka.test/uploads/banners/b-todos.png');
        assert.equal(first.href, '/b/b-todos?from=exam_sidebar');
        assert.equal(first.external, false);
    });

    it('promo institucional: el plan mas barato que no es de docentes, con la institucion si llega al minimo', async () => {
        const { data } = (await get('e1').expect(200)).body;
        assert.equal(data.promo.slug, 'semestral-institucional');
        assert.equal(data.promo.price, 15);
        assert.equal(data.promo.institution.id, 'inst-unmsm');
        assert.equal(data.promo.institution.exams_count, 12);

        // inst-antigua tiene 2 examenes: no llega al minimo, la promo cae al texto general.
        const general = (await get('e4').expect(200)).body.data.promo;
        assert.equal(general.institution, null);
        assert.equal(general.price, 15);
    });

    it('relacionados: otros examenes verificados de la misma institucion, sin el propio', async () => {
        const { data } = (await get('e1').expect(200)).body;
        assert.deepEqual(data.related.map((item) => item.slug), ['unmsm-2024-ii']);
        assert.equal(data.related[0].title, 'Examen UNMSM 2024-II');
    });

    it('un estudiante con suscripcion vigente no recibe la promo y ve sus banners', async () => {
        const premium = await createUser(ctx);
        await ctx.User.updateOne({ _id: premium.session.user.id }, {
            $set: { suscription: { status: 'activo', end_date: new Date(Date.now() + 86_400_000) } },
        });
        const { data } = (await get('e1', premium).expect(200)).body;
        assert.equal(data.promo, null);
        assert.ok(data.banners.banners.some((item) => item.title === 'Banner b-suscriptores'));
    });

    it('examen inexistente o sin verificar: 404', async () => {
        await get('nadie').expect(404);
        await get('e3').expect(404);
    });
});
