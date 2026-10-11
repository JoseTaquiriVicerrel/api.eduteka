import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedExams } from './helpers/seed.js';

const API = '/api/v1';

// Examenes gratuitos (is_free) en el catalogo y la ficha. La descarga en si se prueba en downloads.test.js.
describe('examenes gratuitos: catalogo y ficha', () => {
    let ctx;
    let student;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        await seedExams(ctx);
        student = await createUser(ctx);

        const exams = ctx.mongoose.connection.db.collection('exams');
        // e2 (UNMSM 2024-II) es gratis; e3 es un borrador gratis que no debe verse.
        await exams.updateOne({ _id: 'e2' }, { $set: { is_free: true } });
        await exams.updateOne({ _id: 'e3' }, { $set: { is_free: true } });
        await exams.updateOne({ _id: 'e4' }, { $set: { is_free: true } });
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    const get = (path, user) => request(ctx.app).get(`${API}/examenes${path}`).set(user ? bearer(user) : {});
    const slugs = (res) => res.body.data.map((exam) => exam.slug);

    describe('GET /examenes', () => {
        it('cada examen indica is_free (false si el campo no existe)', async () => {
            const res = await get('').expect(200);
            const free = Object.fromEntries(res.body.data.map((exam) => [exam.slug, exam.is_free]));
            assert.deepEqual(free, { 'unmsm-2025-i': false, 'unmsm-2024-ii': true, 'antigua-2023': true });
        });

        it('?free=true lista solo los gratuitos publicados (un borrador gratis no sale)', async () => {
            const res = await get('?free=true').expect(200);
            assert.deepEqual(slugs(res), ['unmsm-2024-ii', 'antigua-2023']);
            assert.equal(res.body.meta.total, 2);
        });

        it('?free=false no filtra', async () => {
            assert.equal((await get('?free=false').expect(200)).body.meta.total, 3);
        });

        it('se combina con los demas filtros', async () => {
            assert.deepEqual(slugs(await get('?free=true&institution=inst-antigua').expect(200)), ['antigua-2023']);
            assert.deepEqual(slugs(await get('?free=true&modality=Ordinario').expect(200)), ['antigua-2023']);
            assert.deepEqual(slugs(await get('?free=true&q=2025').expect(200)), []);
        });

        it('es publico y valida el valor', async () => {
            await get('?free=true').expect(200);
            await get('?free=quizas').expect(422);
        });
    });

    describe('GET /examenes/:slug (access)', () => {
        it('anonimo: ficha sin preguntas; descargar pide iniciar sesion, aunque el examen sea gratis', async () => {
            const res = await get('/unmsm-2024-ii').expect(200);
            assert.equal(res.body.data.is_free, true);
            assert.deepEqual(res.body.data.items, []);
            assert.equal(res.body.data.access.login_required, true);
            assert.equal(res.body.data.access.can_download, false);
            assert.equal(res.body.data.access.download_requires, 'login');
        });

        it('con sesion y sin plan: un examen gratis se puede descargar; uno de pago pide suscripcion', async () => {
            const free = (await get('/unmsm-2024-ii', student).expect(200)).body.data;
            assert.equal(free.access.can_download, true);
            assert.equal(free.access.download_requires, null);
            assert.equal(free.access.login_required, false);

            const paid = (await get('/unmsm-2025-i', student).expect(200)).body.data;
            assert.equal(paid.is_free, false);
            assert.equal(paid.access.can_download, false);
            assert.equal(paid.access.download_requires, 'subscription');
        });

        it('con suscripcion vigente puede descargar uno de pago; con un plan de otra institucion no', async () => {
            const premium = await createUser(ctx);
            await ctx.User.updateOne({ _id: premium.session.user.id }, {
                $set: { suscription: { status: 'activo', end_date: new Date(Date.now() + 86_400_000) } },
            });
            assert.equal((await get('/unmsm-2025-i', premium).expect(200)).body.data.access.can_download, true);

            const restricted = await createUser(ctx);
            await ctx.User.updateOne({ _id: restricted.session.user.id }, {
                $set: { suscription: { status: 'activo', institution_id: 'inst-antigua', end_date: new Date(Date.now() + 86_400_000) } },
            });
            const blocked = (await get('/unmsm-2025-i', restricted).expect(200)).body.data.access;
            assert.equal(blocked.can_download, false);
            assert.equal(blocked.download_requires, 'institution');

            // El gratis ignora la restriccion de institucion del plan.
            assert.equal((await get('/unmsm-2024-ii', restricted).expect(200)).body.data.access.can_download, true);
        });

        it('el administrador siempre puede descargar', async () => {
            const admin = await createUser(ctx);
            await ctx.User.updateOne({ _id: admin.session.user.id }, { $set: { rol: 'Administrador' } });
            const { access } = (await get('/unmsm-2025-i', admin).expect(200)).body.data;
            assert.equal(access.can_download, true);
            assert.equal(access.download_requires, null);
        });

        it('la ficha avisa de la descarga sin exponer rutas', async () => {
            const { data } = (await get('/unmsm-2025-i').expect(200)).body;
            assert.deepEqual(data.files.map((file) => file.download_url), ['/api/v1/examenes/unmsm-2025-i/pdf?area=A']);
            assert.ok(!JSON.stringify(data).includes('/private/'));
        });
    });
});
