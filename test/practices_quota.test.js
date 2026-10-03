import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

// Plan gratuito con 3 respuestas nuevas por dia: las practicas no pueden ser una
// via para saltarse el limite de /preguntas/:id/responder.
describe('practicas y limite diario', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ FREE_DAILY_ANSWER_LIMIT: '3' });
        await seedCatalog(ctx);
    });
    after(() => ctx.stop());

    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const generate = (user, query = '?area=matematica&count=10') =>
        request(ctx.app).get(`/api/v1/practicas-area/preguntas${query}`).set(bearer(user));
    const finalize = (user, answers) => request(ctx.app).post('/api/v1/practicas-area/finalizar').set(bearer(user)).send({
        area: 'matematica', question_ids: ['q1', 'q2', 'q3', 'q8'], answers,
    });

    it('la tanda generada se recorta al cupo que queda', async () => {
        const user = await createUser(ctx);
        const res = await generate(user).expect(200);

        assert.equal(res.body.data.length, 3);
        assert.deepEqual(res.body.meta, { total: 3, requested: 10, quota_remaining: 3 });
    });

    it('cerrar con mas respuestas nuevas que el cupo -> 403 y no se guarda nada', async () => {
        const user = await createUser(ctx);
        const res = await finalize(user, { q1: 'A', q2: 'A', q3: 'C', q8: 'A' }).expect(403);

        assert.equal(res.body.error.code, 'SUBSCRIPTION_REQUIRED');
        assert.equal(await db('practiceattempts').countDocuments({ user_id: user.session.user.id }), 0);
        assert.equal(await db('useranswers').countDocuments({ user_id: user.session.user.id }), 0);
    });

    it('cerrar dentro del cupo consume el cupo; despues ya no se genera (403)', async () => {
        const user = await createUser(ctx);
        await finalize(user, { q1: 'A', q2: 'A', q3: 'C' }).expect(201);

        const blocked = await generate(user).expect(403);
        assert.equal(blocked.body.error.code, 'SUBSCRIPTION_REQUIRED');
    });

    it('cambiar respuestas ya registradas no consume cupo', async () => {
        const user = await createUser(ctx);
        await finalize(user, { q1: 'A', q2: 'A', q3: 'C' }).expect(201);

        // Mismas preguntas, otras respuestas: no son respuestas nuevas, aunque el cupo este agotado.
        await finalize(user, { q1: 'B', q2: 'B', q3: 'D' }).expect(201);
    });

    it('con suscripcion vigente no se recorta ni se bloquea', async () => {
        const user = await createUser(ctx);
        await ctx.User.updateOne({ _id: user.session.user.id }, {
            $set: { suscription: { status: 'activo', end_date: new Date(Date.now() + 86_400_000) } },
        });

        const res = await generate(user).expect(200);
        assert.equal(res.body.data.length, 4);
        assert.equal(res.body.meta.quota_remaining, null);
        await finalize(user, { q1: 'A', q2: 'A', q3: 'C', q8: 'A' }).expect(201);
    });
});
