import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedSimulacra } from './helpers/seed.js';

const API = '/api/v1/simulacros';

// Cantidad de inscritos en la ficha del simulacro.
describe('simulacros: registered_count en la ficha', () => {
    let ctx;
    const enrollments = () => ctx.mongoose.connection.db.collection('usersimulacrums');
    const detail = (slug) => request(ctx.app).get(`${API}/${slug}`);
    const count = async (slug) => (await detail(slug).expect(200)).body.data.registered_count;
    const row = (id, simulacrum, state) => ({
        _id: id, user_id: `u-${id}`, simulacrum_id: simulacrum, state, finished: false, attempt_number: 1,
    });

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
    });
    after(() => ctx.stop());
    beforeEach(() => ctx.kv.flushMemory());

    it('un simulacro sin inscritos devuelve 0', async () => {
        assert.equal(await count('simulacro-areas'), 0);
    });

    it('cuenta solo las inscripciones aprobadas y solo las de ese simulacro', async () => {
        await enrollments().insertMany([
            row('r1', 's-simulacro-general', true),
            row('r2', 's-simulacro-general', true),
            row('r3', 's-simulacro-general', false), // pago en revision: aun no cuenta
            row('r4', 's-simulacro-areas', true),
        ]);
        assert.equal(await count('simulacro-general'), 2);
        assert.equal(await count('simulacro-areas'), 1);
    });

    it('la ficha es publica: el contador sale sin sesion y con sesion', async () => {
        const user = await createUser(ctx);
        const anonymous = (await detail('simulacro-general').expect(200)).body.data;
        const logged = (await detail('simulacro-general').set(bearer(user)).expect(200)).body.data;
        assert.equal(typeof anonymous.registered_count, 'number');
        assert.equal(logged.registered_count, anonymous.registered_count);
    });

    it('se cachea unos segundos, pero inscribirse lo actualiza al instante', async () => {
        const before = await count('simulacro-general');
        await enrollments().insertOne(row('r5', 's-simulacro-general', true)); // directo a la base: no invalida
        assert.equal(await count('simulacro-general'), before, 'el valor cacheado se mantiene');

        const user = await createUser(ctx);
        await request(ctx.app).post(`${API}/simulacro-general/inscribirme`).set(bearer(user))
            .send({ fullname: 'Ana Pérez López' }).expect(201);
        assert.equal(await count('simulacro-general'), before + 2, 'la inscripcion invalida el cache (y recoge la fila directa)');
    });

    it('tambien aparece en simulacros programados', async () => {
        assert.equal(typeof (await count('evento-vivo')), 'number');
    });
});
