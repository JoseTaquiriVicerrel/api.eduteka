import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp-compact';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedSimulacra } from './helpers/seed.js';

// Politicas configurables: kill-switch de pagos y solucionario con suscripcion.
describe('simulacros: politicas por configuracion', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ APP_PAYMENTS_ENABLED: 'false', SOLUCIONARIO_REQUIRES_PLAN: 'true' });
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
    });
    after(() => ctx.stop());

    const api = (method, route, user, body) => request(ctx.app)[method](`/api/v1/simulacros${route}`).set(bearer(user)).send(body);
    const person = { fullname: 'Ana Pérez López', dni: '12345678' };

    it('con los pagos desactivados, las inscripciones de pago dan 403 y las gratuitas siguen', async () => {
        const user = await createUser(ctx);
        const png = await new Jimp(100, 100, 0x336699ff).getBufferAsync(Jimp.MIME_PNG);
        const paid = await request(ctx.app).post('/api/v1/simulacros/simulacro-pago/inscribirme').set(bearer(user))
            .field('fullname', person.fullname).field('dni', person.dni)
            .attach('screenshot', png, { filename: 'a.png', contentType: 'image/png' })
            .expect(403);
        assert.match(paid.body.error.message, /pago/);

        await api('post', '/simulacro-general/inscribirme', user, person).expect(201);
    });

    it('SOLUCIONARIO_REQUIRES_PLAN: el estudiante necesita suscripcion vigente', async () => {
        const user = await createUser(ctx);
        await api('post', '/simulacro-general/inscribirme', user, person).expect(201);
        const { attempt_id: attemptId } = (await api('post', '/simulacro-general/iniciar', user).expect(200)).body.data;
        await api('post', `/intentos/${attemptId}/finalizar`, user, {}).expect(200);

        const refused = await api('get', '/simulacro-general/solucionario', user).expect(403);
        assert.equal(refused.body.error.code, 'SUBSCRIPTION_REQUIRED');

        await ctx.User.updateOne({ _id: user.session.user.id }, { $set: { suscription: { status: 'activo', end_date: new Date(Date.now() + 86_400_000) } } });
        await api('get', '/simulacro-general/solucionario', user).expect(200);
    });
});
