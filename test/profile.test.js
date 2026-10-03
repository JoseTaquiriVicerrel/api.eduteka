import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from 'image-size';
import Jimp from 'jimp-compact';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

const API = '/api/v1';

describe('perfil', () => {
    let ctx;
    let storageDir;

    before(async () => {
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eduteka-avatars-'));
        ctx = await bootTestApp({ STORAGE_DIR: storageDir, PUBLIC_API_URL: 'https://api.eduteka.test' });
        await seedCatalog(ctx);
    });
    after(async () => {
        await ctx.stop();
        fs.rmSync(storageDir, { recursive: true, force: true });
    });
    beforeEach(() => ctx.kv.flushMemory());

    const get = (path, user) => request(ctx.app).get(`${API}${path}`).set(user ? bearer(user) : {});
    const send = (method, path, user, body) => request(ctx.app)[method](`${API}${path}`).set(user ? bearer(user) : {}).send(body);
    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const login = (email, password) => request(ctx.app).post(`${API}/auth/login`).send({ email, password });

    describe('GET /perfil', () => {
        it('exige sesion', async () => {
            await get('/perfil').expect(401);
        });

        it('devuelve el perfil completo sin datos internos', async () => {
            const user = await createUser(ctx);
            const res = await get('/perfil', user).expect(200);

            assert.equal(res.body.data.email, user.email.toLowerCase());
            assert.equal(res.body.data.username, 'Usuario Semilla');
            assert.equal(res.body.data.institution, null);
            assert.equal(res.body.data.account_type_change_available, true);
            assert.equal(res.body.data.suscription, null);
            const json = JSON.stringify(res.body);
            for (const secret of ['password', 'token_verify', 'token_recovery', 'password_reset_jti', '$2b$']) {
                assert.ok(!json.includes(secret), `expone ${secret}`);
            }
        });

        it('incluye la institucion preferente y la suscripcion con dias restantes', async () => {
            const user = await createUser(ctx);
            await ctx.User.updateOne({ _id: user.session.user.id }, {
                $set: { university: 'inst-unmsm', suscription: { status: 'activo', slug: 'plan', end_date: new Date(Date.now() + 5 * 86_400_000) } },
            });
            const res = await get('/perfil', user).expect(200);

            assert.deepEqual(res.body.data.institution, { id: 'inst-unmsm', name: 'UNMSM', abrev: 'SM' });
            assert.equal(res.body.data.suscription.days_remaining, 5);
            assert.equal(res.body.data.suscription.active, true);
        });
    });

    describe('PATCH /perfil', () => {
        it('actualiza nombre, departamento, notificaciones e institucion', async () => {
            const user = await createUser(ctx);
            const res = await send('patch', '/perfil', user, {
                username: 'Nuevo Nombre', departament: 'Cusco', notification: true, university: 'inst-unmsm',
            }).expect(200);

            assert.equal(res.body.data.username, 'Nuevo Nombre');
            assert.equal(res.body.data.departament, 'Cusco');
            assert.equal(res.body.data.notification, true);
            assert.equal(res.body.data.institution.id, 'inst-unmsm');
            assert.equal((await ctx.User.findById(user.session.user.id)).username, 'Nuevo Nombre');
        });

        it('valida: cuerpo vacio, campos ajenos, nombre invalido, institucion inexistente o desactivada', async () => {
            const user = await createUser(ctx);
            await send('patch', '/perfil', user, {}).expect(422);
            await send('patch', '/perfil', user, { rol: 'Administrador' }).expect(422);
            await send('patch', '/perfil', user, { email: 'otro@example.com' }).expect(422);
            await send('patch', '/perfil', user, { username: ' ab ' }).expect(422);
            const missing = await send('patch', '/perfil', user, { university: 'no-existe' }).expect(422);
            assert.equal(missing.body.error.details[0].field, 'university');
            await send('patch', '/perfil', user, { university: 'inst-oculta' }).expect(422);
            await send('patch', '/perfil', null, { username: 'Anonimo' }).expect(401);
        });

        it('no se puede escalar privilegios: rol y estado no son editables', async () => {
            const user = await createUser(ctx);
            await send('patch', '/perfil', user, { rol: 'Administrador', state: true, isVerified: true }).expect(422);
            assert.equal((await ctx.User.findById(user.session.user.id)).rol, 'User');
        });

        it('el tipo de cuenta se puede cambiar UNA vez; despues 403', async () => {
            const user = await createUser(ctx);
            const first = await send('patch', '/perfil', user, { account_type: 'Profesor' }).expect(200);
            assert.equal(first.body.data.account_type, 'Profesor');
            assert.equal(first.body.data.account_type_change_available, false);
            assert.deepEqual(first.body.data.capabilities, ['TEACHER_TOOLS']);

            const second = await send('patch', '/perfil', user, { account_type: 'Estudiante' }).expect(403);
            assert.equal(second.body.error.code, 'FORBIDDEN');
            // Repetir el mismo valor no cuenta como cambio.
            await send('patch', '/perfil', user, { account_type: 'Profesor' }).expect(200);
        });

        it('teaching_area: solo para profesores y con un area que exista; al dejar de serlo se limpia', async () => {
            const student = await createUser(ctx);
            const refused = await send('patch', '/perfil', student, { teaching_area: 'area-mat' }).expect(422);
            assert.equal(refused.body.error.details[0].field, 'teaching_area');

            const teacher = await createUser(ctx, { account_type: 'Profesor' });
            await send('patch', '/perfil', teacher, { teaching_area: 'no-existe' }).expect(422);
            const ok = await send('patch', '/perfil', teacher, { teaching_area: 'area-mat' }).expect(200);
            assert.equal(ok.body.data.teaching_area, 'area-mat');

            // Un profesor que cambia (una vez) a estudiante pierde el curso.
            const changed = await send('patch', '/perfil', teacher, { account_type: 'Estudiante' }).expect(200);
            assert.equal(changed.body.data.teaching_area, null);
        });

        it('cambiar de tipo y fijar el curso en la misma peticion', async () => {
            const user = await createUser(ctx);
            const res = await send('patch', '/perfil', user, { account_type: 'Profesor', teaching_area: 'area-len' }).expect(200);
            assert.equal(res.body.data.teaching_area, 'area-len');
        });
    });

    describe('POST /perfil/cambiar-password', () => {
        const change = (user, body) => send('post', '/perfil/cambiar-password', user, body);

        it('exige sesion y valida los datos', async () => {
            await change(null, { current_password: 'x', new_password: 'Nueva1234' }).expect(401);
            const user = await createUser(ctx);
            await change(user, { current_password: 'Passw0rd!', new_password: 'corta' }).expect(422);
            await change(user, { current_password: 'Passw0rd!', new_password: 'x'.repeat(16) }).expect(422);
            await change(user, { new_password: 'Nueva1234' }).expect(422);
        });

        it('una contraseña actual incorrecta da 422 (no 401: la app no debe intentar refrescar)', async () => {
            const user = await createUser(ctx);
            const res = await change(user, { current_password: 'Equivocada1', new_password: 'Nueva1234' }).expect(422);
            assert.equal(res.body.error.details[0].field, 'current_password');
            await login(user.email, 'Passw0rd!').expect(200);
        });

        it('la nueva debe ser distinta de la actual', async () => {
            const user = await createUser(ctx);
            const res = await change(user, { current_password: 'Passw0rd!', new_password: 'Passw0rd!' }).expect(422);
            assert.equal(res.body.error.details[0].field, 'new_password');
        });

        it('cambia la contraseña y cierra TODAS las sesiones si no se indica la del dispositivo', async () => {
            const user = await createUser(ctx);
            const other = (await login(user.email, 'Passw0rd!').expect(200)).body.data;

            const res = await change(user, { current_password: 'Passw0rd!', new_password: 'Nueva1234' }).expect(200);
            assert.deepEqual(res.body.data, { changed: true, current_session_kept: false });

            await login(user.email, 'Passw0rd!').expect(401);
            await login(user.email, 'Nueva1234').expect(200);
            await request(ctx.app).post(`${API}/auth/refresh`).send({ refresh_token: other.refresh_token }).expect(401);
            await request(ctx.app).post(`${API}/auth/refresh`).send({ refresh_token: user.session.refresh_token }).expect(401);
        });

        it('con el refresh_token del dispositivo, conserva esa sesion y cierra las demas', async () => {
            const user = await createUser(ctx);
            const other = (await login(user.email, 'Passw0rd!').expect(200)).body.data;

            const res = await change(user, {
                current_password: 'Passw0rd!', new_password: 'Nueva1234', refresh_token: user.session.refresh_token,
            }).expect(200);
            assert.equal(res.body.data.current_session_kept, true);

            await request(ctx.app).post(`${API}/auth/refresh`).send({ refresh_token: user.session.refresh_token }).expect(200);
            await request(ctx.app).post(`${API}/auth/refresh`).send({ refresh_token: other.refresh_token }).expect(401);
        });

        it('el refresh_token de OTRO usuario no conserva nada', async () => {
            const alice = await createUser(ctx);
            const bob = await createUser(ctx);
            const res = await change(alice, {
                current_password: 'Passw0rd!', new_password: 'Nueva1234', refresh_token: bob.session.refresh_token,
            }).expect(200);
            assert.equal(res.body.data.current_session_kept, false);
            await request(ctx.app).post(`${API}/auth/refresh`).send({ refresh_token: bob.session.refresh_token }).expect(200);
        });

        it('comparte el limite de fallos del login: 5 contraseñas malas bloquean (429)', async () => {
            const user = await createUser(ctx);
            for (let i = 0; i < 5; i += 1) {
                await change(user, { current_password: 'Equivocada1', new_password: 'Nueva1234' }).expect(422);
            }
            const locked = await change(user, { current_password: 'Passw0rd!', new_password: 'Nueva1234' }).expect(429);
            assert.ok(Number(locked.headers['retry-after']) > 0);
            // El bloqueo tambien alcanza al login de esa cuenta.
            await login(user.email, 'Passw0rd!').expect(429);
        });

        it('anula un restablecimiento pendiente', async () => {
            const user = await createUser(ctx);
            await ctx.User.updateOne({ _id: user.session.user.id }, { $set: { password_reset_jti: 'pendiente' } });
            await change(user, { current_password: 'Passw0rd!', new_password: 'Nueva1234' }).expect(200);
            assert.equal((await ctx.User.findById(user.session.user.id)).password_reset_jti, undefined);
        });
    });

    describe('DELETE /perfil', () => {
        const remove = (user, body) => send('delete', '/perfil', user, body);

        it('exige sesion y la contraseña', async () => {
            await remove(null, { password: 'x' }).expect(401);
            const user = await createUser(ctx);
            await remove(user, {}).expect(422);
            const wrong = await remove(user, { password: 'Equivocada1' }).expect(422);
            assert.equal(wrong.body.error.details[0].field, 'password');
            await get('/perfil', user).expect(200);
        });

        it('un administrador no puede borrarse desde la app', async () => {
            const admin = await createUser(ctx);
            await ctx.User.updateOne({ _id: admin.session.user.id }, { $set: { rol: 'Administrador' } });
            const res = await remove(admin, { password: 'Passw0rd!' }).expect(403);
            assert.equal(res.body.error.code, 'FORBIDDEN');
        });

        it('anonimiza la cuenta, cierra las sesiones y libera el correo', async () => {
            const user = await createUser(ctx);
            const id = user.session.user.id;
            await ctx.User.updateOne({ _id: id }, { $set: { dni: '12345678', fullname: 'Nombre Real', departament: 'Lima', university: 'inst-unmsm' } });
            await db('userquestionslists').insertMany([
                { _id: `${id}-priv`, user: id, name: 'Privada', public: false, questions: [] },
                { _id: `${id}-pub`, user: id, name: 'Publica', public: true, slug: `publica-${id}`, questions: [] },
            ]);

            await remove(user, { password: 'Passw0rd!' }).expect(204);

            const raw = await db('users').findOne({ _id: id });
            assert.equal(raw.state, false);
            assert.equal(raw.email, `deleted+${id}@deleted.invalid`);
            for (const field of ['password', 'dni', 'fullname', 'departament', 'university', 'avatar', 'token_verify']) {
                assert.equal(raw[field], undefined, `${field} sigue en la cuenta`);
            }
            // El historial financiero y de estudio conserva el user_id.
            assert.equal(raw._id, id);

            assert.equal(await db('userquestionslists').countDocuments({ _id: `${id}-priv` }), 0);
            assert.equal((await db('userquestionslists').findOne({ _id: `${id}-pub` })).user, undefined);

            // Ya no entra, no refresca y el token vigente queda inutilizado.
            await login(user.email, 'Passw0rd!').expect(401);
            await request(ctx.app).post(`${API}/auth/refresh`).send({ refresh_token: user.session.refresh_token }).expect(401);
            const stale = await get('/perfil', user).expect(403);
            assert.equal(stale.body.error.code, 'ACCOUNT_DISABLED');

            // El correo original queda libre para registrarse de nuevo.
            await request(ctx.app).post(`${API}/auth/register`).send({
                email: user.email, password: 'Passw0rd!', username: 'Vuelvo', departament: 'Lima', account_type: 'Estudiante',
            }).expect(201);
        });
    });

    describe('POST /perfil/avatar', () => {
        const image = async (width, height, mime = Jimp.MIME_PNG, color = 0x336699ff) =>
            new Jimp(width, height, color).getBufferAsync(mime);
        const upload = (user, buffer, { field = 'avatar', filename = 'foto.png', contentType = 'image/png' } = {}) =>
            request(ctx.app).post(`${API}/perfil/avatar`).set(user ? bearer(user) : {}).attach(field, buffer, { filename, contentType });

        it('exige sesion', async () => {
            await upload(null, await image(300, 300)).expect(401);
        });

        it('guarda un JPEG cuadrado de 256 px y devuelve la URL absoluta de la API', async () => {
            const user = await createUser(ctx);
            const res = await upload(user, await image(500, 300)).expect(200);
            const url = res.body.data.avatar;

            assert.match(url, /^https:\/\/api\.eduteka\.test\/api\/v1\/media\/avatars\/[A-Za-z0-9_-]+\.jpg$/);
            const file = path.join(storageDir, 'avatars', path.basename(url));
            assert.ok(fs.existsSync(file), 'el archivo no se guardo');
            const info = imageSize(fs.readFileSync(file));
            assert.deepEqual([info.type, info.width, info.height], ['jpg', 256, 256]);
        });

        it('acepta JPEG y PNG con transparencia (se aplana sobre blanco)', async () => {
            const user = await createUser(ctx);
            await upload(user, await image(200, 200, Jimp.MIME_JPEG), { filename: 'a.jpg', contentType: 'image/jpeg' }).expect(200);
            await upload(user, await image(200, 200, Jimp.MIME_PNG, 0x00000000)).expect(200);
        });

        it('se sirve publicamente con cache larga e inmutable', async () => {
            const user = await createUser(ctx);
            const uploaded = await upload(user, await image(300, 300)).expect(200);
            const route = new URL(uploaded.body.data.avatar).pathname;

            const res = await request(ctx.app).get(route).expect(200);
            assert.equal(res.headers['content-type'], 'image/jpeg');
            assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
            assert.equal(res.headers['x-content-type-options'], 'nosniff');
        });

        it('reemplazar el avatar borra el archivo anterior', async () => {
            const user = await createUser(ctx);
            const first = (await upload(user, await image(300, 300)).expect(200)).body.data.avatar;
            const second = (await upload(user, await image(300, 300, Jimp.MIME_PNG, 0xaa0000ff)).expect(200)).body.data.avatar;

            assert.notEqual(first, second);
            assert.ok(!fs.existsSync(path.join(storageDir, 'avatars', path.basename(first))));
            assert.ok(fs.existsSync(path.join(storageDir, 'avatars', path.basename(second))));
            assert.equal((await get('/perfil', user).expect(200)).body.data.avatar, second);
        });

        it('rechaza lo que no es una imagen valida aunque declare image/png', async () => {
            const user = await createUser(ctx);
            const fake = await upload(user, Buffer.from('<?php echo 1; ?> esto no es un png'), { contentType: 'image/png' }).expect(422);
            assert.equal(fake.body.error.details[0].field, 'avatar');
        });

        it('rechaza tipos no permitidos (gif, webp, svg) y tamaños fuera de rango', async () => {
            const user = await createUser(ctx);
            await upload(user, await image(300, 300), { filename: 'a.gif', contentType: 'image/gif' }).expect(422);
            await upload(user, await image(300, 300), { filename: 'a.webp', contentType: 'image/webp' }).expect(422);
            await upload(user, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { filename: 'a.svg', contentType: 'image/svg+xml' }).expect(422);
            await upload(user, await image(30, 30)).expect(422); // < 64 px
            await upload(user, await image(3001, 100)).expect(422); // > 3000 px
        });

        it('mas de 2 MB -> 413', async () => {
            const user = await createUser(ctx);
            const res = await upload(user, Buffer.alloc(3 * 1024 * 1024, 1)).expect(413);
            assert.equal(res.body.error.code, 'PAYLOAD_TOO_LARGE');
        });

        it('el campo debe llamarse avatar y llevar un solo archivo', async () => {
            const user = await createUser(ctx);
            await upload(user, await image(300, 300), { field: 'foto' }).expect(422);
            await request(ctx.app).post(`${API}/perfil/avatar`).set(bearer(user)).send({}).expect(422);
            await request(ctx.app).post(`${API}/perfil/avatar`).set(bearer(user))
                .attach('avatar', await image(300, 300), { filename: 'a.png', contentType: 'image/png' })
                .attach('avatar', await image(300, 300), { filename: 'b.png', contentType: 'image/png' })
                .expect(422);
        });

        it('no se puede leer fuera del directorio de avatares ni archivos que no sean .jpg', async () => {
            await request(ctx.app).get(`${API}/media/avatars/..%2f..%2fpackage.json`).expect(404);
            await request(ctx.app).get(`${API}/media/avatars/..%5C..%5Cpackage.json`).expect(404);
            await request(ctx.app).get(`${API}/media/avatars/secreto.txt`).expect(404);
            await request(ctx.app).get(`${API}/media/avatars/no-existe.jpg`).expect(404);
        });
    });

    describe('GET /perfil/intentos', () => {
        let user;

        before(async () => {
            user = await createUser(ctx);
            const id = user.session.user.id;
            await db('questions').insertOne({ _id: 'qh', area: 'Matemática', area_id: 'area-mat', verified: true, rpta: 'A', question: 'x', options: { A: 'a', B: 'b' } });
            await db('userquestionslists').insertOne({ _id: 'lh', name: 'Mi práctica', slug: 'mi-practica', public: true, questions: ['qh'] });
            await db('simulacrums').insertOne({ _id: 'sim1', title: 'Simulacro UNMSM', slug: 'simulacro-unmsm' });

            const t = (n) => new Date(Date.UTC(2026, 2, n));
            await db('practiceattempts').insertMany([
                { _id: 'pa1', user_id: id, source: 'area', area_id: 'area-mat', topic: 'Álgebra', answers: { q1: 'A' }, time: 90, total_questions: 10, questions_correct: 7, questions_incorrect: 2, questions_not_answered: 1, created_at: t(1) },
                { _id: 'pa2', user_id: id, source: 'lista', practice_id: 'lh', practice_slug: 'mi-practica', answers: { qh: 'A' }, time: 30, total_questions: 4, questions_correct: 4, questions_incorrect: 0, questions_not_answered: 0, created_at: t(3) },
                { _id: 'pa-otro', user_id: 'otro-usuario', source: 'area', area_id: 'area-mat', total_questions: 1, created_at: t(4) },
            ]);
            await db('usersimulacrums').insertOne({
                _id: 'us1', user_id: id, simulacrum_id: 'sim1', finished: true, attempt_number: 2,
                questions_correct: 30, questions_incorrect: 10, questions_not_answered: 5, score: 120.5, score_conversion: 14.2,
                exam_finished: t(5), created_at: t(5),
            });
            await db('simulacrumattempts').insertOne({
                _id: 'sa1', user_simulacrum_id: 'us1', user_id: id, simulacrum_id: 'sim1', attempt_number: 1,
                questions_correct: 20, questions_incorrect: 20, questions_not_answered: 5, score: 80, exam_finished: t(2), created_at: t(2),
            });
        });

        it('exige sesion', async () => {
            await get('/perfil/intentos').expect(401);
        });

        it('mezcla practicas y simulacros, del mas reciente al mas antiguo, solo del usuario', async () => {
            const res = await get('/perfil/intentos', user).expect(200);

            assert.deepEqual(res.body.data.map((item) => item.id), ['us1|2', 'pa2', 'us1|1', 'pa1']);
            assert.deepEqual(res.body.meta, { page: 1, limit: 20, total: 4, has_more: false });
            assert.ok(!JSON.stringify(res.body).includes('"answers"'));
        });

        it('etiqueta cada intento y calcula el acierto sobre lo respondido', async () => {
            const res = await get('/perfil/intentos', user).expect(200);
            const byId = Object.fromEntries(res.body.data.map((item) => [item.id, item]));

            assert.equal(byId.pa1.label, 'Matemática');
            assert.equal(byId.pa1.source, 'area');
            assert.equal(byId.pa1.topic, 'Álgebra');
            assert.equal(byId.pa1.accuracy, 0.778);
            assert.equal(byId.pa1.time, 90);
            assert.equal(byId.pa2.label, 'Mi práctica');
            assert.equal(byId.pa2.practice_slug, 'mi-practica');
            assert.equal(byId['us1|2'].label, 'Simulacro UNMSM');
            assert.equal(byId['us1|2'].simulacrum_slug, 'simulacro-unmsm');
            assert.equal(byId['us1|2'].attempt_number, 2);
            assert.equal(byId['us1|2'].score, 120.5);
            assert.equal(byId['us1|1'].score, 80);
        });

        it('filtra por tipo y pagina', async () => {
            const practice = await get('/perfil/intentos?type=practica', user).expect(200);
            assert.deepEqual(practice.body.data.map((item) => item.id), ['pa2', 'pa1']);
            assert.equal(practice.body.meta.total, 2);

            const simulacra = await get('/perfil/intentos?type=simulacro', user).expect(200);
            assert.deepEqual(simulacra.body.data.map((item) => item.id), ['us1|2', 'us1|1']);

            const page2 = await get('/perfil/intentos?limit=3&page=2', user).expect(200);
            assert.deepEqual(page2.body.data.map((item) => item.id), ['pa1']);
            assert.deepEqual(page2.body.meta, { page: 2, limit: 3, total: 4, has_more: false });
        });

        it('valida el filtro', async () => {
            await get('/perfil/intentos?type=otro', user).expect(422);
            await get('/perfil/intentos?limit=51', user).expect(422);
        });

        it('un usuario sin intentos recibe una lista vacia', async () => {
            const empty = await createUser(ctx);
            const res = await get('/perfil/intentos', empty).expect(200);
            assert.deepEqual(res.body.data, []);
            assert.equal(res.body.meta.total, 0);
        });
    });
});
