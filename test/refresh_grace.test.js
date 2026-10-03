import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp, lastCode } from './helpers/boot.js';

// Con REFRESH_GRACE_SECONDS=30, un refresh token recien rotado sigue valiendo
// para el mismo dueño: es la carrera de varias peticiones que reciben 401 a la vez.
describe('refresh con ventana de gracia', () => {
    let ctx;
    let counter = 0;
    before(async () => { ctx = await bootTestApp({ REFRESH_GRACE_SECONDS: '30' }); });
    after(() => ctx.stop());

    const post = (path, body) => request(ctx.app).post(`/api/v1/auth${path}`).send(body);

    const session = async () => {
        counter += 1;
        const email = `grace${counter}@example.com`;
        await post('/register', {
            email, password: 'Passw0rd!', username: 'Usuario Gracia', departament: 'Lima', account_type: 'Estudiante',
        }).expect(201);
        const res = await post('/verify-code', { email, code: lastCode(ctx.outbox, email) }).expect(200);
        return res.body.data;
    };

    const refresh = (token) => post('/refresh', { refresh_token: token });

    it('dos refresh simultaneos con el mismo token: ambos reciben sesion', async () => {
        const { refresh_token: token } = await session();
        const [a, b] = await Promise.all([refresh(token), refresh(token)]);

        assert.deepEqual([a.status, b.status], [200, 200]);
        assert.notEqual(a.body.data.refresh_token, b.body.data.refresh_token);
        // Los dos tokens nuevos son validos y pertenecen a la misma familia.
        await refresh(a.body.data.refresh_token).expect(200);
        await refresh(b.body.data.refresh_token).expect(200);
    });

    it('reutilizar el token viejo justo despues de rotar sigue funcionando y no cierra la sesion', async () => {
        const { refresh_token: token } = await session();
        const first = await refresh(token).expect(200);

        await refresh(token).expect(200);
        // El sucesor original no se vio afectado.
        await refresh(first.body.data.refresh_token).expect(200);
    });

    it('pasada la gracia, reutilizar el token viejo revoca toda la familia', async () => {
        const { refresh_token: token, user } = await session();
        const rotated = await refresh(token).expect(200);

        // Se "envejece" la rotacion mas alla de la ventana.
        await ctx.RefreshToken.updateMany(
            { user_id: user.id, replaced_by: { $ne: null } },
            { $set: { revoked_at: new Date(Date.now() - 60_000) } },
        );

        await refresh(token).expect(401);
        await refresh(rotated.body.data.refresh_token).expect(401);
    });

    it('tras un logout, el token viejo ya no se puede reutilizar aunque este dentro de la gracia', async () => {
        const original = await session();
        const rotated = await refresh(original.refresh_token).expect(200);

        await request(ctx.app).post('/api/v1/auth/logout')
            .set('Authorization', `Bearer ${rotated.body.data.access_token}`)
            .send({ refresh_token: rotated.body.data.refresh_token })
            .expect(204);

        await refresh(original.refresh_token).expect(401);
        await refresh(rotated.body.data.refresh_token).expect(401);
    });

    it('si se revocaron todas las sesiones (cambio de contraseña), el token viejo tampoco sirve', async () => {
        const original = await session();
        await refresh(original.refresh_token).expect(200);

        await ctx.RefreshToken.updateMany({ user_id: original.user.id, revoked_at: null }, { $set: { revoked_at: new Date() } });
        await refresh(original.refresh_token).expect(401);
    });

    it('un token que nunca existio sigue dando 401 y no crea sesion', async () => {
        await refresh('z'.repeat(43)).expect(401);
    });

    it('la cuenta desactivada no puede refrescar ni dentro de la gracia', async () => {
        const { refresh_token: token, user } = await session();
        await refresh(token).expect(200);
        await ctx.User.updateOne({ _id: user.id }, { $set: { state: false } });

        const res = await refresh(token).expect(403);
        assert.equal(res.body.error.code, 'ACCOUNT_DISABLED');
    });
});
