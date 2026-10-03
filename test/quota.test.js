import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

// Plan gratuito: 2 respuestas NUEVAS por dia (hora de Lima).
describe('limite diario de respuestas', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ FREE_DAILY_ANSWER_LIMIT: '2' });
        await seedCatalog(ctx);
    });
    after(() => ctx.stop());

    const answer = async (id, selected, user) => {
        // El bloqueo anti doble-toque no es lo que se prueba aqui.
        await ctx.kv.del(`answer-lock:${user.session.user.id}:${id}`);
        return request(ctx.app).post(`/api/v1/preguntas/${id}/responder`).set(bearer(user)).send({ selected });
    };
    const status = async (id, selected, user) => (await answer(id, selected, user)).status;
    const collection = (name) => ctx.mongoose.connection.db.collection(name);

    it('la tercera respuesta nueva del dia -> 403 SUBSCRIPTION_REQUIRED', async () => {
        const user = await createUser(ctx);
        assert.equal(await status('q1', 'A', user), 200);
        assert.equal(await status('q2', 'A', user), 200);

        const blocked = await answer('q3', 'C', user);
        assert.equal(blocked.status, 403);
        assert.equal(blocked.body.error.code, 'SUBSCRIPTION_REQUIRED');
        assert.match(blocked.body.error.message, /2 respuestas diarias/);
    });

    it('cambiar la respuesta de una pregunta ya respondida no consume cupo, ni con el cupo agotado', async () => {
        const user = await createUser(ctx);
        assert.equal(await status('q1', 'A', user), 200);
        assert.equal(await status('q2', 'A', user), 200);

        assert.equal(await status('q1', 'B', user), 200);
        assert.equal(await status('q2', 'B', user), 200);
        assert.equal(await status('q3', 'C', user), 403);
    });

    it('una respuesta rechazada por el cupo no deja rastro en los contadores', async () => {
        const user = await createUser(ctx);
        await answer('q1', 'A', user);
        await answer('q2', 'A', user);
        const before = await collection('questions').findOne({ _id: 'q7' });

        assert.equal(await status('q7', 'D', user), 403);

        const after = await collection('questions').findOne({ _id: 'q7' });
        assert.equal(after.total_answers, before.total_answers);
        assert.equal(await collection('useranswers').countDocuments({ user_id: user.session.user.id, question_id: 'q7' }), 0);
    });

    it('con suscripcion activa no hay limite', async () => {
        const user = await createUser(ctx);
        await ctx.User.updateOne({ _id: user.session.user.id }, {
            $set: { suscription: { status: 'activo', end_date: new Date(Date.now() + 86_400_000) } },
        });

        for (const id of ['q1', 'q2', 'q3', 'q7', 'q8']) {
            assert.equal(await status(id, 'A', user), 200, id);
        }
    });

    it('una suscripcion vencida (cron pendiente) no exime del limite', async () => {
        const user = await createUser(ctx);
        await ctx.User.updateOne({ _id: user.session.user.id }, {
            $set: { suscription: { status: 'activo', end_date: new Date(Date.now() - 1000) } },
        });

        assert.equal(await status('q1', 'A', user), 200);
        assert.equal(await status('q2', 'A', user), 200);
        assert.equal(await status('q3', 'A', user), 403);
    });

    it('el administrador no tiene limite', async () => {
        const admin = await createUser(ctx);
        await ctx.User.updateOne({ _id: admin.session.user.id }, { $set: { rol: 'Administrador' } });

        for (const id of ['q1', 'q2', 'q3']) {
            assert.equal(await status(id, 'A', admin), 200, id);
        }
    });

    it('el cupo se reinicia al cambiar el dia (hora de Lima)', async () => {
        const user = await createUser(ctx);
        await answer('q1', 'A', user);
        await answer('q2', 'A', user);
        assert.equal(await status('q3', 'C', user), 403);

        // Simula la medianoche: la ventana diaria caduca.
        ctx.kv.flushMemory();
        assert.equal(await status('q3', 'C', user), 200);
    });
});
