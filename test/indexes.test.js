import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp } from './helpers/boot.js';

// La API comparte la base con el monolito, que es el dueño de los indices. Con
// autoIndex desactivado globalmente la API no debe crear ninguno en las
// colecciones compartidas, y si los de su propia coleccion (refreshtokens).
describe('indices', () => {
    let ctx;
    before(async () => { ctx = await bootTestApp(); });
    after(() => ctx.stop());

    const indexesOf = async (collection) => {
        try {
            return await ctx.mongoose.connection.db.collection(collection).indexes();
        } catch {
            return []; // la coleccion no existe (autoCreate desactivado)
        }
    };

    it('refreshtokens crea sus indices: hash unico, TTL por expires_at, usuario y familia', async () => {
        const indexes = await indexesOf('refreshtokens');
        const byKey = (key) => indexes.find((index) => Object.keys(index.key).join() === key);

        assert.equal(byKey('token_hash')?.unique, true);
        assert.equal(byKey('expires_at')?.expireAfterSeconds, 0);
        assert.ok(byKey('user_id'));
        assert.ok(byKey('family_id'));
    });

    it('los modelos del monolito NO crean indices al inicializarse', async () => {
        const { default: Question } = await import('#Models/question_model.js');
        const { default: Area } = await import('#Models/area_model.js');
        const { default: UserSimulacrum } = await import('#Models/user_simulacrum_model.js');

        await Promise.all([Question.init(), Area.init(), UserSimulacrum.init()]);

        for (const collection of ['questions', 'areas', 'usersimulacrums']) {
            const names = (await indexesOf(collection)).map((index) => index.name);
            assert.ok(names.every((name) => name === '_id_'), `${collection} tiene indices creados por la API: ${names}`);
        }
    });

    it('users solo tiene el indice unico de email que el propio arranque de la prueba crea', async () => {
        const names = (await indexesOf('users')).map((index) => index.name).sort();
        assert.deepEqual(names, ['_id_', 'email_1']);
    });
});
