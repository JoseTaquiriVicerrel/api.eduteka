import bcrypt from 'bcrypt';
import UserModel from '#Models/user_model.js';
import RefreshTokenModel from '#Models/refresh_token_model.js';
import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { del, setNX, ttl as ttlOf } from '#Libs/kv.js';
import { assertNotLocked, clearFailures, recordFailure } from './login_throttle.js';
import { sendMail } from '#Libs/mailer.js';
import {
    generateCode, generateRefreshToken, hashCode, newId, safeEqual, sha256,
    signAccessToken, signResetToken, verifyResetToken,
} from '#Libs/tokens.js';
import { AUTH_USER_FIELDS } from '#Middlewares/authenticate.js';
import { serializeUser } from '#Serializers/user.serializer.js';

// Logica de /auth. Los controladores solo validan y responden.
//
// Notas de diseño:
//  - Los codigos de 6 digitos se guardan como HMAC (#Libs/tokens.js), con
//    vencimiento e intentos maximos. Agotar los intentos invalida el codigo.
//  - Registro y envio de codigos comparten un enfriamiento por correo que se
//    aplica ANTES de mirar si la cuenta existe: asi la respuesta no delata que
//    correos estan registrados.
//  - Tras exceder los fallos de login de un correo se rechaza hasta la
//    respuesta correcta, para que el bloqueo no sirva de oraculo de contraseñas.

const MINUTE_MS = 60 * 1000;

// --- Utilidades -------------------------------------------------------------

const clip = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

/** Datos del dispositivo y la IP que se guardan junto al refresh token. */
export const requestContext = (req) => ({
    ip: req.ip,
    device: {
        name: clip(req.get('x-device-name'), 100),
        platform: clip(req.get('x-device-platform'), 30),
        app_version: clip(req.get('x-app-version'), 30),
    },
});

let dummyHashPromise;
// Hash de relleno: comparar contra el cuando el correo no existe iguala el
// tiempo de respuesta con el de una cuenta real.
const dummyHash = () => (dummyHashPromise ??= bcrypt.hash(newId(), settings.auth.bcryptRounds));

const hashPassword = (password) => bcrypt.hash(password, settings.auth.bcryptRounds);

const cooldownKey = (purpose, email) => `cooldown:${purpose}:${email}`;

const takeCooldown = async (purpose, email) => {
    const seconds = settings.auth.codeCooldownSeconds;
    if (seconds === 0) return;
    const key = cooldownKey(purpose, email);
    if (!(await setNX(key, seconds))) {
        throw ApiError.tooManyRequests(await ttlOf(key), 'Espera un momento antes de pedir otro código.');
    }
};

const releaseCooldown = (purpose, email) => del(cooldownKey(purpose, email));

// --- Sesion -----------------------------------------------------------------

const issueSession = async (user, ctx, familyId = newId()) => {
    const { token, hash } = generateRefreshToken();

    await RefreshTokenModel.create({
        user_id: user._id,
        family_id: familyId,
        token_hash: hash,
        expires_at: new Date(Date.now() + settings.jwt.refreshTtlDays * 24 * 60 * MINUTE_MS),
        device: ctx.device,
        ip: ctx.ip,
    });

    return {
        access_token: await signAccessToken({ uid: user._id, rol: user.rol }),
        refresh_token: token,
        token_type: 'Bearer',
        expires_in: settings.jwt.accessTtlSeconds,
        user: serializeUser(user),
    };
};

const revokeFamily = (familyId) =>
    RefreshTokenModel.updateMany({ family_id: familyId, revoked_at: null }, { $set: { revoked_at: new Date() } }).exec();

const revokeAllForUser = (userId) =>
    RefreshTokenModel.updateMany({ user_id: userId, revoked_at: null }, { $set: { revoked_at: new Date() } }).exec();

// --- Codigos ----------------------------------------------------------------

const CODE_FIELDS = {
    verify: { hash: 'token_verify', expires: 'token_verify_expires', attempts: 'token_verify_attempts', ttlMinutes: () => settings.auth.verifyCodeTtlMinutes },
    recovery: { hash: 'token_recovery_verify', expires: 'token_recovery_expires', attempts: 'token_recovery_attempts', ttlMinutes: () => settings.auth.recoveryCodeTtlMinutes },
};

/** Genera un codigo, guarda su HMAC con vencimiento y devuelve el codigo en claro. */
const issueCode = async (purpose, user) => {
    const fields = CODE_FIELDS[purpose];
    const code = generateCode();

    await UserModel.updateOne({ _id: user._id }, {
        $set: {
            [fields.hash]: hashCode(purpose, user.email, code),
            [fields.expires]: new Date(Date.now() + fields.ttlMinutes() * MINUTE_MS),
            [fields.attempts]: 0,
        },
    }).exec();

    return code;
};

/**
 * Comprueba un codigo. Lanza INVALID_CODE (mismo mensaje) si la cuenta no existe,
 * no tiene codigo pendiente, venció, agotó los intentos o el codigo no coincide.
 * Cada comprobacion consume un intento de forma atomica, aunque lleguen en paralelo.
 */
const consumeCode = async ({ purpose, email, code, filter = {} }) => {
    const fields = CODE_FIELDS[purpose];

    const user = await UserModel.findOne({ email, ...filter }, {
        _id: 1, email: 1, username: 1, rol: 1, [fields.hash]: 1, [fields.expires]: 1,
    }).lean().exec();

    if (!user || !user[fields.hash] || !user[fields.expires] || new Date(user[fields.expires]) <= new Date()) {
        throw ApiError.invalidCode();
    }

    // `$not: { $gte: max }` tambien casa con un campo ausente (cuentas creadas fuera de la API).
    const claimed = await UserModel.updateOne(
        { _id: user._id, [fields.attempts]: { $not: { $gte: settings.auth.codeMaxAttempts } } },
        { $inc: { [fields.attempts]: 1 } },
    ).exec();
    if (claimed.matchedCount === 0) throw ApiError.invalidCode();

    if (!safeEqual(user[fields.hash], hashCode(purpose, user.email, code))) throw ApiError.invalidCode();

    return user;
};

const sendCodeMail = (purpose, user, code) => sendMail({
    to: user.email,
    subject: purpose === 'verify' ? 'Tu código de verificación de Eduteka' : 'Código para recuperar tu contraseña de Eduteka',
    template: purpose === 'verify' ? 'api_verification_code' : 'api_recovery_code',
    data: { username: user.username, code, minutes: CODE_FIELDS[purpose].ttlMinutes() },
});

// --- Casos de uso -----------------------------------------------------------

export const register = async (body) => {
    const { email } = body;

    const existing = await UserModel.findOne({ email }, { _id: 1, isVerified: 1 }).lean().exec();
    if (existing?.isVerified) throw ApiError.conflict('Este correo ya está registrado.');

    await takeCooldown('verify', email);

    const profile = {
        username: body.username,
        departament: body.departament,
        account_type: body.account_type,
        university: body.university,
        teaching_area: body.teaching_area,
        notification: body.edkNotification ?? false,
        password: await hashPassword(body.password),
    };

    try {
        // Una cuenta sin verificar se sobrescribe: es quien no llego a confirmar el
        // codigo y vuelve a registrarse (o alguien que perdio el correo).
        const user = existing
            ? await UserModel.findOneAndUpdate({ _id: existing._id, isVerified: { $ne: true } }, { $set: profile }, { new: true, projection: { _id: 1, email: 1, username: 1 } }).lean().exec()
            : await UserModel.create({ email, rol: 'User', state: true, isVerified: false, ...profile });

        if (!user) throw ApiError.conflict('Este correo ya está registrado.');

        const code = await issueCode('verify', { _id: user._id, email });
        const sent = await sendCodeMail('verify', { email, username: profile.username }, code);
        if (!sent) {
            await releaseCooldown('verify', email);
            throw ApiError.emailDeliveryFailed();
        }
    } catch (error) {
        // Registro simultaneo del mismo correo (indice unico de users.email).
        if (error?.code === 11000) throw ApiError.conflict('Este correo ya está registrado.');
        throw error;
    }

    return {
        email,
        verification_required: true,
        code_expires_in: settings.auth.verifyCodeTtlMinutes * 60,
        resend_available_in: settings.auth.codeCooldownSeconds,
    };
};

export const resendCode = async ({ email }) => {
    await takeCooldown('verify', email);

    const user = await UserModel.findOne({ email }, { _id: 1, email: 1, username: 1, isVerified: 1, state: 1 }).lean().exec();

    if (user && !user.isVerified && user.state !== false) {
        const code = await issueCode('verify', user);
        void sendCodeMail('verify', user, code); // sendMail nunca lanza; no se espera para no delatar la cuenta
    }

    return { sent: true };
};

export const verifyCode = async ({ email, code }, ctx) => {
    const user = await consumeCode({ purpose: 'verify', email, code, filter: { isVerified: { $ne: true }, state: { $ne: false } } });

    const verified = await UserModel.findOneAndUpdate(
        { _id: user._id, isVerified: { $ne: true } },
        {
            $set: { isVerified: true, last_session: new Date() },
            $unset: { token_verify: 1, token_verify_expires: 1, token_verify_attempts: 1 },
        },
        { new: true, projection: AUTH_USER_FIELDS },
    ).lean().exec();

    if (!verified) throw ApiError.invalidCode();

    return issueSession(verified, ctx);
};

export const login = async ({ email, password }, ctx) => {
    await assertNotLocked(email);

    const user = await UserModel.findOne({ email }, AUTH_USER_FIELDS).select('+password').lean().exec();

    const matches = await bcrypt.compare(password, user?.password ?? (await dummyHash()));
    if (!user || !user.password || !matches) {
        await recordFailure(email);
        throw ApiError.invalidCredentials();
    }

    // Solo tras acertar la contraseña se revela el estado de la cuenta.
    await clearFailures(email);
    if (user.state === false) throw ApiError.accountDisabled();
    if (!user.isVerified) throw ApiError.emailNotVerified();

    await UserModel.updateOne({ _id: user._id }, { $set: { last_session: new Date() } }).exec();
    return issueSession(user, ctx);
};

// Un token ya rotado hace poco, de una familia que sigue viva, es casi seguro una
// carrera entre peticiones de la propia app (varias reciben 401 y todas refrescan
// con el mismo token), no un robo. Se rota de nuevo en vez de cerrar la sesion.
// Si la familia ya no tiene ningun token vivo (logout, reuso detectado, cambio de
// contraseña) NO hay gracia: el token viejo no puede resucitar la sesion.
const isConcurrentRefresh = async (known, now) => {
    const graceMs = settings.jwt.refreshGraceSeconds * 1000;
    if (graceMs <= 0 || !known.replaced_by || !known.revoked_at) return false;
    if (now - new Date(known.revoked_at) > graceMs) return false;

    return Boolean(await RefreshTokenModel.exists({
        family_id: known.family_id,
        revoked_at: null,
        expires_at: { $gt: now },
    }));
};

export const refresh = async ({ refresh_token: presented }, ctx) => {
    const hash = sha256(presented);
    const now = new Date();
    let nextId = newId();

    // Reclama el token de forma atomica: solo uno de dos usos simultaneos gana.
    let current = await RefreshTokenModel.findOneAndUpdate(
        { token_hash: hash, revoked_at: null, expires_at: { $gt: now } },
        { $set: { revoked_at: now, replaced_by: nextId } },
        { projection: { user_id: 1, family_id: 1 } },
    ).lean().exec();

    if (!current) {
        const known = await RefreshTokenModel.findOne(
            { token_hash: hash },
            { user_id: 1, family_id: 1, expires_at: 1, revoked_at: 1, replaced_by: 1 },
        ).lean().exec();

        if (!known || known.expires_at <= now) throw ApiError.unauthenticated();

        if (!(await isConcurrentRefresh(known, now))) {
            // Un token conocido, ya rotado fuera de la gracia o revocado, se esta
            // reutilizando: alguien lo copio. Se corta toda la familia, incluido el
            // token vigente del dueño.
            await revokeFamily(known.family_id);
            throw ApiError.unauthenticated();
        }

        current = known;
        nextId = newId(); // el token viejo ya apunta a su sucesor; este es un hermano
    }

    const user = await UserModel.findById(current.user_id, AUTH_USER_FIELDS).lean().exec();
    if (!user || user.state === false || !user.isVerified) {
        await revokeFamily(current.family_id);
        throw user?.state === false ? ApiError.accountDisabled() : ApiError.unauthenticated();
    }

    const next = generateRefreshToken();
    await RefreshTokenModel.create({
        _id: nextId,
        user_id: user._id,
        family_id: current.family_id,
        token_hash: next.hash,
        expires_at: new Date(Date.now() + settings.jwt.refreshTtlDays * 24 * 60 * MINUTE_MS),
        device: ctx.device,
        ip: ctx.ip,
    });

    return {
        access_token: await signAccessToken({ uid: user._id, rol: user.rol }),
        refresh_token: next.token,
        token_type: 'Bearer',
        expires_in: settings.jwt.accessTtlSeconds,
        user: serializeUser(user),
    };
};

/** Revoca la familia del refresh token presentado. Idempotente: si no existe, no falla. */
export const logout = async (userId, { refresh_token: presented }) => {
    const token = await RefreshTokenModel.findOne({ token_hash: sha256(presented), user_id: userId }, { family_id: 1 }).lean().exec();
    if (token) await revokeFamily(token.family_id);
};

export const recover = async ({ email }) => {
    await takeCooldown('recovery', email);

    const user = await UserModel.findOne(
        { email, isVerified: true, state: { $ne: false } },
        { _id: 1, email: 1, username: 1 },
    ).lean().exec();

    if (user) {
        const code = await issueCode('recovery', user);
        // Un codigo nuevo anula cualquier token de restablecimiento pendiente.
        await UserModel.updateOne({ _id: user._id }, { $unset: { password_reset_jti: 1 } }).exec();
        void sendCodeMail('recovery', user, code);
    }

    return { sent: true };
};

export const verifyRecoveryCode = async ({ email, code }) => {
    const user = await consumeCode({ purpose: 'recovery', email, code, filter: { isVerified: true, state: { $ne: false } } });

    const jti = newId();
    await UserModel.updateOne({ _id: user._id }, {
        $set: { password_reset_jti: jti },
        $unset: { token_recovery_verify: 1, token_recovery_expires: 1, token_recovery_attempts: 1 },
    }).exec();

    return {
        reset_token: await signResetToken(user._id, jti),
        expires_in: settings.jwt.resetTtlSeconds,
    };
};

export const resetPassword = async ({ reset_token: resetToken, password }) => {
    let payload;
    try {
        payload = await verifyResetToken(resetToken);
    } catch {
        throw ApiError.invalidToken();
    }
    // Sin jti/uid el filtro de abajo casaria con cualquier cuenta (Mongoose descarta
    // los `undefined`), asi que se exigen explicitamente.
    if (typeof payload.uid !== 'string' || typeof payload.jti !== 'string') throw ApiError.invalidToken();

    const passwordHash = await hashPassword(password);

    const user = await UserModel.findOneAndUpdate(
        { _id: payload.uid, password_reset_jti: payload.jti, state: { $ne: false } },
        { $set: { password: passwordHash }, $unset: { password_reset_jti: 1 } },
        { projection: { _id: 1 } },
    ).lean().exec();

    if (!user) throw ApiError.invalidToken();

    await revokeAllForUser(user._id);
    return { reset: true };
};

export const me = (user) => serializeUser(user);
