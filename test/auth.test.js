import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { SignJWT } from 'jose';
import request from 'supertest';
import { bootTestApp, lastCode, settle } from './helpers/boot.js';

const API = '/api/v1/auth';
const PASSWORD = 'Passw0rd!';

let ctx;
let counter = 0;

const newUser = (overrides = {}) => {
    counter += 1;
    return {
        email: `user${counter}@example.com`,
        password: PASSWORD,
        username: 'Usuario Prueba',
        departament: 'Lima',
        account_type: 'Estudiante',
        ...overrides,
    };
};

const post = (path, body, headers = {}) => request(ctx.app).post(`${API}${path}`).set(headers).send(body);
const get = (path, token) => {
    const req = request(ctx.app).get(`${API}${path}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

/** Registra y verifica una cuenta; devuelve sus datos y la sesion. */
const createVerifiedUser = async (overrides = {}) => {
    const body = newUser(overrides);
    await post('/register', body).expect(201);
    const code = lastCode(ctx.outbox, body.email, 'api_verification_code');
    const res = await post('/verify-code', { email: body.email, code }).expect(200);
    return { body, session: res.body.data };
};

before(async () => { ctx = await bootTestApp(); });
after(() => ctx.stop());
beforeEach(() => ctx.kv.flushMemory());

describe('POST /auth/register', () => {
    it('crea la cuenta sin verificar, guarda el correo en minusculas y la contraseña con hash', async () => {
        const body = newUser({ email: 'Ana.Perez@Example.COM', edkNotification: true });
        const res = await post('/register', body).expect(201);

        assert.equal(res.body.data.email, 'ana.perez@example.com');
        assert.equal(res.body.data.verification_required, true);
        assert.ok(res.body.data.code_expires_in > 0);
        assert.ok(!JSON.stringify(res.body).includes(lastCode(ctx.outbox, 'ana.perez@example.com')), 'la respuesta no debe contener el codigo');

        const user = await ctx.User.findOne({ email: 'ana.perez@example.com' }).select('+password').lean();
        assert.equal(user.isVerified, false);
        assert.equal(user.rol, 'User');
        assert.equal(user.notification, true);
        assert.notEqual(user.password, PASSWORD);
        assert.ok(await bcrypt.compare(PASSWORD, user.password));
        // El codigo se guarda como HMAC, nunca en claro.
        const code = lastCode(ctx.outbox, 'ana.perez@example.com', 'api_verification_code');
        assert.match(code, /^\d{6}$/);
        assert.notEqual(user.token_verify, code);
        assert.match(user.token_verify, /^[0-9a-f]{64}$/);
        assert.ok(user.token_verify_expires > new Date());
    });

    it('rechaza datos invalidos con 422 y detalle por campo', async () => {
        const res = await post('/register', { email: 'no-es-correo', password: 'corta', username: ' x ', account_type: 'Otro' }).expect(422);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
        const fields = res.body.error.details.map((detail) => detail.field);
        for (const field of ['email', 'password', 'username', 'departament', 'account_type']) {
            assert.ok(fields.includes(field), `falta el detalle de ${field}: ${fields}`);
        }
    });

    it('rechaza campos que no existen en el contrato', async () => {
        const res = await post('/register', { ...newUser(), rol: 'Administrador' }).expect(422);
        assert.ok(res.body.error.details.some((detail) => detail.field === 'rol'));
    });

    it('una contraseña de mas de 15 caracteres se rechaza', async () => {
        await post('/register', newUser({ password: 'x'.repeat(16) })).expect(422);
    });

    it('un correo ya verificado -> 409 CONFLICT', async () => {
        const { body } = await createVerifiedUser();
        const res = await post('/register', newUser({ email: body.email.toUpperCase() })).expect(409);
        assert.equal(res.body.error.code, 'CONFLICT');
    });

    it('volver a registrar una cuenta sin verificar la actualiza y anula el codigo anterior', async () => {
        const body = newUser();
        await post('/register', body).expect(201);
        const oldCode = lastCode(ctx.outbox, body.email);

        await post('/register', { ...body, username: 'Nombre Nuevo', password: 'Otra1234!' }).expect(201);
        const newCode = lastCode(ctx.outbox, body.email);

        assert.equal(await ctx.User.countDocuments({ email: body.email }), 1);
        assert.equal((await ctx.User.findOne({ email: body.email })).username, 'Nombre Nuevo');

        if (oldCode !== newCode) {
            await post('/verify-code', { email: body.email, code: oldCode }).expect(400);
        }
        await post('/verify-code', { email: body.email, code: newCode }).expect(200);
        // Y entra con la contraseña nueva.
        await post('/login', { email: body.email, password: 'Otra1234!' }).expect(200);
        await post('/login', { email: body.email, password: PASSWORD }).expect(401);
    });

    it('si el correo no se puede enviar -> 503 y la cuenta queda para reenviar', async () => {
        const original = ctx.outbox.push;
        ctx.outbox.push = () => { throw new Error('smtp caido'); };
        try {
            const res = await post('/register', newUser()).expect(503);
            assert.equal(res.body.error.code, 'EMAIL_DELIVERY_FAILED');
        } finally {
            ctx.outbox.push = original;
        }
    });
});

describe('POST /auth/verify-code y /auth/resend-code', () => {
    it('con el codigo correcto verifica la cuenta y devuelve tokens y usuario', async () => {
        const body = newUser();
        await post('/register', body).expect(201);
        const code = lastCode(ctx.outbox, body.email);

        const res = await post('/verify-code', { email: body.email, code }).expect(200);
        const { data } = res.body;
        assert.equal(data.token_type, 'Bearer');
        assert.equal(data.expires_in, 1800);
        assert.ok(data.access_token && data.refresh_token);
        assert.equal(data.user.email, body.email);
        assert.equal(data.user.is_verified, true);
        assert.deepEqual(data.user.capabilities.sort(), ['TAKE_SIMULACRUM', 'TRACK_PROGRESS', 'USE_PRACTICES']);

        const user = await ctx.User.findOne({ email: body.email }).lean();
        assert.equal(user.isVerified, true);
        assert.equal(user.token_verify, undefined);
        assert.equal(user.token_verify_expires, undefined);
    });

    it('un codigo incorrecto -> 400 INVALID_CODE', async () => {
        const body = newUser();
        await post('/register', body).expect(201);
        const code = lastCode(ctx.outbox, body.email);
        const wrong = code === '000000' ? '111111' : '000000';
        const res = await post('/verify-code', { email: body.email, code: wrong }).expect(400);
        assert.equal(res.body.error.code, 'INVALID_CODE');
    });

    it('tras 5 intentos fallidos el codigo se invalida aunque luego sea el correcto', async () => {
        const body = newUser();
        await post('/register', body).expect(201);
        const code = lastCode(ctx.outbox, body.email);
        const wrong = code === '000000' ? '111111' : '000000';

        for (let i = 0; i < 5; i += 1) await post('/verify-code', { email: body.email, code: wrong }).expect(400);
        await post('/verify-code', { email: body.email, code }).expect(400);
        assert.equal((await ctx.User.findOne({ email: body.email })).isVerified, false);

        // Pedir un codigo nuevo lo rehabilita.
        await post('/resend-code', { email: body.email }).expect(200);
        await settle();
        await post('/verify-code', { email: body.email, code: lastCode(ctx.outbox, body.email) }).expect(200);
    });

    it('un codigo vencido -> 400', async () => {
        const body = newUser();
        await post('/register', body).expect(201);
        const code = lastCode(ctx.outbox, body.email);
        await ctx.User.updateOne({ email: body.email }, { $set: { token_verify_expires: new Date(Date.now() - 1000) } });
        await post('/verify-code', { email: body.email, code }).expect(400);
    });

    it('correo inexistente o cuenta ya verificada dan el mismo error', async () => {
        const unknown = await post('/verify-code', { email: 'nadie@example.com', code: '123456' }).expect(400);
        const { body } = await createVerifiedUser();
        const verified = await post('/verify-code', { email: body.email, code: '123456' }).expect(400);
        assert.deepEqual(unknown.body.error, verified.body.error);
    });

    it('el formato del codigo se valida (6 digitos)', async () => {
        await post('/verify-code', { email: 'a@example.com', code: '12ab56' }).expect(422);
        await post('/verify-code', { email: 'a@example.com', code: '12345' }).expect(422);
    });

    it('resend-code responde igual exista o no el correo, y solo envia a cuentas sin verificar', async () => {
        const pending = newUser();
        await post('/register', pending).expect(201);
        const sentBefore = ctx.outbox.length;

        const known = await post('/resend-code', { email: pending.email }).expect(200);
        const unknown = await post('/resend-code', { email: 'fantasma@example.com' }).expect(200);
        const { body: verifiedUser } = await createVerifiedUser();
        const sentAfterRegister = ctx.outbox.length;
        const verified = await post('/resend-code', { email: verifiedUser.email }).expect(200);
        await settle();

        assert.deepEqual(known.body, unknown.body);
        assert.deepEqual(known.body, verified.body);
        assert.equal(ctx.outbox.length, sentBefore + 1 + 1, 'solo la cuenta pendiente recibe correo (mas el del registro del verificado)');
        assert.equal(ctx.outbox.length, sentAfterRegister + 0, 'la cuenta verificada no recibe correo');
        assert.equal(ctx.outbox.at(-1).to === verifiedUser.email, true);
    });
});

describe('POST /auth/login', () => {
    it('devuelve tokens y un usuario sin datos internos', async () => {
        const { body } = await createVerifiedUser();
        const res = await post('/login', { email: body.email.toUpperCase(), password: PASSWORD }).expect(200);

        assert.ok(res.body.data.access_token);
        assert.ok(res.body.data.refresh_token);
        const serialized = JSON.stringify(res.body);
        for (const secret of ['password', 'token_verify', 'token_recovery', 'password_reset_jti', '$2b$']) {
            assert.ok(!serialized.includes(secret), `la respuesta contiene ${secret}`);
        }
        assert.ok((await ctx.User.findOne({ email: body.email })).last_session);
    });

    it('contraseña incorrecta y correo inexistente responden igual (sin enumeracion)', async () => {
        const { body } = await createVerifiedUser();
        const wrongPassword = await post('/login', { email: body.email, password: 'Equivocada1' }).expect(401);
        const unknown = await post('/login', { email: 'nadie@example.com', password: 'Equivocada1' }).expect(401);
        assert.equal(wrongPassword.body.error.code, 'INVALID_CREDENTIALS');
        assert.deepEqual(wrongPassword.body.error, unknown.body.error);
    });

    it('cuenta sin verificar: 403 EMAIL_NOT_VERIFIED solo con la contraseña correcta', async () => {
        const body = newUser();
        await post('/register', body).expect(201);

        const good = await post('/login', { email: body.email, password: PASSWORD }).expect(403);
        assert.equal(good.body.error.code, 'EMAIL_NOT_VERIFIED');
        const bad = await post('/login', { email: body.email, password: 'Equivocada1' }).expect(401);
        assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
    });

    it('cuenta desactivada -> 403 ACCOUNT_DISABLED', async () => {
        const { body } = await createVerifiedUser();
        await ctx.User.updateOne({ email: body.email }, { $set: { state: false } });
        const res = await post('/login', { email: body.email, password: PASSWORD }).expect(403);
        assert.equal(res.body.error.code, 'ACCOUNT_DISABLED');
    });

    it('una cuenta sin contraseña (creada fuera de la API) no puede entrar', async () => {
        await ctx.User.create({ email: 'sinpass@example.com', isVerified: true, rol: 'User' });
        await post('/login', { email: 'sinpass@example.com', password: PASSWORD }).expect(401);
    });

    it('tras 5 fallos el correo se bloquea (429 + Retry-After), incluso con la contraseña correcta', async () => {
        const { body } = await createVerifiedUser();
        for (let i = 0; i < 5; i += 1) await post('/login', { email: body.email, password: 'Equivocada1' }).expect(401);

        const locked = await post('/login', { email: body.email, password: PASSWORD }).expect(429);
        assert.equal(locked.body.error.code, 'TOO_MANY_REQUESTS');
        assert.ok(Number(locked.headers['retry-after']) > 0);
    });

    it('un login correcto reinicia el contador de fallos', async () => {
        const { body } = await createVerifiedUser();
        for (let i = 0; i < 4; i += 1) await post('/login', { email: body.email, password: 'Equivocada1' }).expect(401);
        await post('/login', { email: body.email, password: PASSWORD }).expect(200);
        for (let i = 0; i < 4; i += 1) await post('/login', { email: body.email, password: 'Equivocada1' }).expect(401);
        await post('/login', { email: body.email, password: PASSWORD }).expect(200);
    });

    it('valida el cuerpo', async () => {
        await post('/login', {}).expect(422);
        await post('/login', { email: 'a@example.com', password: 'x', extra: 1 }).expect(422);
    });
});

describe('GET /auth/me y autenticacion por Bearer', () => {
    it('sin token -> 401 UNAUTHENTICATED', async () => {
        const res = await get('/me').expect(401);
        assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    });

    it('token basura -> 401', async () => {
        await get('/me', 'no.es.un.jwt').expect(401);
    });

    it('con un access token valido devuelve el usuario', async () => {
        const { body, session } = await createVerifiedUser();
        const res = await get('/me', session.access_token).expect(200);
        assert.equal(res.body.data.email, body.email);
        assert.equal(res.body.data.id, session.user.id);
        assert.equal(res.body.data.suscription, null);
    });

    it('un refresh token no sirve como access token', async () => {
        const { session } = await createVerifiedUser();
        await get('/me', session.refresh_token).expect(401);
    });

    it('un token firmado con otra clave o de otro tipo (typ) no sirve', async () => {
        const { session } = await createVerifiedUser();
        const forge = (secret, typ) => new SignJWT({ uid: session.user.id, rol: 'Administrador', typ })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setIssuer('eduteka-api')
            .setExpirationTime('10m')
            .sign(new TextEncoder().encode(secret));

        await get('/me', await forge('otra-clave-otra-clave-otra-clave-otra-clave-1', 'access')).expect(401);
        // Firmado con la clave correcta pero con typ de otro flujo.
        await get('/me', await forge(process.env.JWT_SECRET, 'reset')).expect(401);
        await get('/me', await forge(process.env.JWT_SECRET, 'access')).expect(200);
    });

    it('un access token vencido -> 401', async () => {
        const { session } = await createVerifiedUser();
        const expired = await new SignJWT({ uid: session.user.id, typ: 'access' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
            .setIssuer('eduteka-api')
            .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
            .sign(new TextEncoder().encode(process.env.JWT_SECRET));
        await get('/me', expired).expect(401);
    });

    it('un token valido de un usuario desactivado -> 403 ACCOUNT_DISABLED', async () => {
        const { body, session } = await createVerifiedUser();
        await ctx.User.updateOne({ email: body.email }, { $set: { state: false } });
        const res = await get('/me', session.access_token).expect(403);
        assert.equal(res.body.error.code, 'ACCOUNT_DISABLED');
    });

    it('un usuario eliminado con token vigente -> 401', async () => {
        const { body, session } = await createVerifiedUser();
        await ctx.User.deleteOne({ email: body.email });
        await get('/me', session.access_token).expect(401);
    });

    it('suscripcion activa: dias restantes y capacidad de descarga', async () => {
        const { body, session } = await createVerifiedUser();
        const end = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
        await ctx.User.updateOne({ email: body.email }, { $set: { suscription: { status: 'activo', slug: 'plan-6m', name: '6 meses', start_date: new Date(), end_date: end } } });

        const res = await get('/me', session.access_token).expect(200);
        assert.equal(res.body.data.suscription.active, true);
        assert.equal(res.body.data.suscription.days_remaining, 10);
        assert.equal(res.body.data.suscription.slug, 'plan-6m');
        assert.ok(res.body.data.capabilities.includes('DOWNLOAD_EXAMS'));
    });

    it('suscripcion vencida pero aun marcada activo (cron pendiente): no es premium', async () => {
        const { body, session } = await createVerifiedUser();
        await ctx.User.updateOne({ email: body.email }, { $set: { suscription: { status: 'activo', end_date: new Date(Date.now() - 1000) } } });

        const res = await get('/me', session.access_token).expect(200);
        assert.equal(res.body.data.suscription.active, false);
        assert.ok(!res.body.data.capabilities.includes('DOWNLOAD_EXAMS'));
    });

    it('cuenta Profesor: herramientas de docente, sin simulacros ni progreso', async () => {
        const { session } = await createVerifiedUser({ account_type: 'Profesor', teaching_area: 'area-lenguaje' });
        const res = await get('/me', session.access_token).expect(200);
        assert.deepEqual(res.body.data.capabilities, ['TEACHER_TOOLS']);
        assert.equal(res.body.data.teaching_area, 'area-lenguaje');
    });
});

describe('POST /auth/refresh y /auth/logout', () => {
    it('rota el refresh token: el nuevo funciona y el anterior deja de servir', async () => {
        const { session } = await createVerifiedUser();
        const first = await post('/refresh', { refresh_token: session.refresh_token }).expect(200);

        assert.notEqual(first.body.data.refresh_token, session.refresh_token);
        assert.ok(first.body.data.access_token);
        assert.equal(first.body.data.user.id, session.user.id);

        const second = await post('/refresh', { refresh_token: first.body.data.refresh_token }).expect(200);
        assert.ok(second.body.data.refresh_token);
    });

    it('reutilizar un refresh token ya rotado revoca toda la familia', async () => {
        const { session } = await createVerifiedUser();
        const rotated = await post('/refresh', { refresh_token: session.refresh_token }).expect(200);

        // Alguien presenta el token viejo: 401 y, ademas, el token nuevo (del dueño) queda revocado.
        const reuse = await post('/refresh', { refresh_token: session.refresh_token }).expect(401);
        assert.equal(reuse.body.error.code, 'UNAUTHENTICATED');
        await post('/refresh', { refresh_token: rotated.body.data.refresh_token }).expect(401);
    });

    it('dos usos simultaneos del mismo token: solo uno gana', async () => {
        const { session } = await createVerifiedUser();
        const results = await Promise.all([
            post('/refresh', { refresh_token: session.refresh_token }),
            post('/refresh', { refresh_token: session.refresh_token }),
        ]);
        const statuses = results.map((res) => res.status).sort();
        assert.deepEqual(statuses, [200, 401]);
    });

    it('token desconocido, vencido o con formato invalido -> 401 / 422', async () => {
        await post('/refresh', { refresh_token: 'a'.repeat(43) }).expect(401);
        await post('/refresh', { refresh_token: 'corto' }).expect(422);

        const { session } = await createVerifiedUser();
        await ctx.RefreshToken.updateMany({ user_id: session.user.id }, { $set: { expires_at: new Date(Date.now() - 1000) } });
        await post('/refresh', { refresh_token: session.refresh_token }).expect(401);
    });

    it('solo se guarda el hash del refresh token', async () => {
        const { session } = await createVerifiedUser();
        const stored = await ctx.RefreshToken.find({ user_id: session.user.id }).lean();
        assert.equal(stored.length, 1);
        assert.notEqual(stored[0].token_hash, session.refresh_token);
        assert.match(stored[0].token_hash, /^[0-9a-f]{64}$/);
        assert.ok(stored[0].expires_at > new Date(Date.now() + 59 * 24 * 60 * 60 * 1000));
    });

    it('cuenta desactivada tras el login: el refresh da 403 y la familia queda revocada', async () => {
        const { body, session } = await createVerifiedUser();
        await ctx.User.updateOne({ email: body.email }, { $set: { state: false } });
        const res = await post('/refresh', { refresh_token: session.refresh_token }).expect(403);
        assert.equal(res.body.error.code, 'ACCOUNT_DISABLED');

        await ctx.User.updateOne({ email: body.email }, { $set: { state: true } });
        await post('/refresh', { refresh_token: session.refresh_token }).expect(401);
    });

    it('guarda dispositivo e IP junto al token', async () => {
        const body = newUser();
        await post('/register', body).expect(201);
        const code = lastCode(ctx.outbox, body.email);
        const res = await post('/verify-code', { email: body.email, code }, {
            'X-Device-Name': 'Pixel 8', 'X-Device-Platform': 'android', 'X-App-Version': '1.4.2',
        }).expect(200);

        const stored = await ctx.RefreshToken.findOne({ user_id: res.body.data.user.id }).lean();
        assert.equal(stored.device.name, 'Pixel 8');
        assert.equal(stored.device.platform, 'android');
        assert.equal(stored.device.app_version, '1.4.2');
        assert.ok(stored.ip);
    });

    it('logout revoca la familia; sin Bearer da 401', async () => {
        const { session } = await createVerifiedUser();
        await post('/logout', { refresh_token: session.refresh_token }).expect(401);

        await request(ctx.app).post(`${API}/logout`).set('Authorization', `Bearer ${session.access_token}`)
            .send({ refresh_token: session.refresh_token }).expect(204);
        await post('/refresh', { refresh_token: session.refresh_token }).expect(401);
    });

    it('logout con el refresh token de otro usuario no lo revoca', async () => {
        const alice = await createVerifiedUser();
        const bob = await createVerifiedUser();

        await request(ctx.app).post(`${API}/logout`).set('Authorization', `Bearer ${alice.session.access_token}`)
            .send({ refresh_token: bob.session.refresh_token }).expect(204);
        await post('/refresh', { refresh_token: bob.session.refresh_token }).expect(200);
    });
});

describe('recuperacion de contraseña', () => {
    const recoverAndGetCode = async (email) => {
        await post('/recover', { email }).expect(200);
        await settle();
        return lastCode(ctx.outbox, email, 'api_recovery_code');
    };

    it('recover responde igual exista o no el correo y solo envia a cuentas verificadas', async () => {
        const { body } = await createVerifiedUser();
        const pending = newUser();
        await post('/register', pending).expect(201);

        const before = ctx.outbox.length;
        const known = await post('/recover', { email: body.email }).expect(200);
        const unknown = await post('/recover', { email: 'nadie@example.com' }).expect(200);
        const unverified = await post('/recover', { email: pending.email }).expect(200);
        await settle();

        assert.deepEqual(known.body, unknown.body);
        assert.deepEqual(known.body, unverified.body);
        assert.equal(ctx.outbox.length, before + 1);
        assert.equal(ctx.outbox.at(-1).to, body.email);
    });

    it('flujo completo: codigo -> reset_token -> nueva contraseña; revoca todas las sesiones', async () => {
        const { body, session } = await createVerifiedUser();
        const code = await recoverAndGetCode(body.email);

        const verified = await post('/verify-recovery-code', { email: body.email, code }).expect(200);
        const { reset_token: resetToken, expires_in: expiresIn } = verified.body.data;
        assert.ok(resetToken);
        assert.equal(expiresIn, 900);

        const newPassword = 'NuevaClave9';
        await post('/reset-password', { reset_token: resetToken, password: newPassword }).expect(200);

        await post('/login', { email: body.email, password: PASSWORD }).expect(401);
        await post('/login', { email: body.email, password: newPassword }).expect(200);
        // La sesion anterior se cerro en todos los dispositivos.
        await post('/refresh', { refresh_token: session.refresh_token }).expect(401);
    });

    it('el reset_token es de un solo uso', async () => {
        const { body } = await createVerifiedUser();
        const code = await recoverAndGetCode(body.email);
        const { reset_token: resetToken } = (await post('/verify-recovery-code', { email: body.email, code }).expect(200)).body.data;

        await post('/reset-password', { reset_token: resetToken, password: 'NuevaClave9' }).expect(200);
        const again = await post('/reset-password', { reset_token: resetToken, password: 'OtraClave99' }).expect(400);
        assert.equal(again.body.error.code, 'INVALID_TOKEN');
        await post('/login', { email: body.email, password: 'NuevaClave9' }).expect(200);
    });

    it('pedir un codigo nuevo anula el reset_token anterior', async () => {
        const { body } = await createVerifiedUser();
        const code = await recoverAndGetCode(body.email);
        const { reset_token: resetToken } = (await post('/verify-recovery-code', { email: body.email, code }).expect(200)).body.data;

        await recoverAndGetCode(body.email);
        await post('/reset-password', { reset_token: resetToken, password: 'NuevaClave9' }).expect(400);
    });

    it('un access token o un token basura no sirven como reset_token', async () => {
        const { session } = await createVerifiedUser();
        await post('/reset-password', { reset_token: session.access_token, password: 'NuevaClave9' }).expect(400);
        await post('/reset-password', { reset_token: 'x'.repeat(40), password: 'NuevaClave9' }).expect(400);
    });

    it('un reset_token sin jti no puede restablecer ninguna cuenta', async () => {
        const { body, session } = await createVerifiedUser();
        // Firmado con la clave y el issuer correctos, pero sin jti.
        const forged = await new SignJWT({ uid: session.user.id, typ: 'reset' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setIssuer('eduteka-api')
            .setExpirationTime('10m')
            .sign(new TextEncoder().encode(process.env.JWT_SECRET));

        await post('/reset-password', { reset_token: forged, password: 'Hackeada123' }).expect(400);
        await post('/login', { email: body.email, password: PASSWORD }).expect(200);
    });

    it('codigo incorrecto -> 400; tras 5 fallos el codigo queda invalidado', async () => {
        const { body } = await createVerifiedUser();
        const code = await recoverAndGetCode(body.email);
        const wrong = code === '000000' ? '111111' : '000000';

        for (let i = 0; i < 5; i += 1) {
            const res = await post('/verify-recovery-code', { email: body.email, code: wrong }).expect(400);
            assert.equal(res.body.error.code, 'INVALID_CODE');
        }
        await post('/verify-recovery-code', { email: body.email, code }).expect(400);
    });

    it('un codigo de verificacion no sirve como codigo de recuperacion (ni al reves)', async () => {
        const body = newUser();
        await post('/register', body).expect(201);
        const verifyCode = lastCode(ctx.outbox, body.email, 'api_verification_code');
        await post('/verify-recovery-code', { email: body.email, code: verifyCode }).expect(400);

        await post('/verify-code', { email: body.email, code: verifyCode }).expect(200);
        const recoveryCode = await recoverAndGetCode(body.email);
        await post('/verify-code', { email: body.email, code: recoveryCode }).expect(400);
    });

    it('la nueva contraseña respeta 8-15 caracteres', async () => {
        await post('/reset-password', { reset_token: 'x'.repeat(40), password: 'corta' }).expect(422);
    });
});

describe('unicidad de correo', () => {
    it('dos registros simultaneos del mismo correo: uno crea y el otro recibe 409', async () => {
        const body = newUser();
        const results = await Promise.all([post('/register', body), post('/register', body)]);
        const statuses = results.map((res) => res.status).sort();
        // Uno crea (201); el otro ve la cuenta sin verificar y la actualiza (201) o choca con el indice (409).
        assert.ok(statuses.every((status) => [201, 409].includes(status)), `estados: ${statuses}`);
        assert.equal(await ctx.User.countDocuments({ email: body.email }), 1);
    });
});
