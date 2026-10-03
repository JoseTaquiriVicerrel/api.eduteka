import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { settings } from '#Config/settings.js';

// Tokens y codigos de la API.
//
//  - access:  JWT HS256 { uid, rol, typ:'access' }, corto y sin estado.
//  - refresh: valor aleatorio de 256 bits. En BD solo se guarda su SHA-256.
//  - reset:   JWT { uid, typ:'reset', jti } de un solo uso.
//
// El secreto de estos JWT (JWT_SECRET) es DISTINTO del que firma la cookie de
// sesion del monolito (JWT_PRIVATE_KEY): asi un token de la API no se puede
// pegar como cookie de la web ni al reves. El claim `typ` impide ademas
// reutilizar un token en otro flujo.

const encoder = new TextEncoder();
const accessKey = encoder.encode(settings.jwt.secret);
const resetKey = encoder.encode(settings.jwt.resetSecret);

const sign = (payload, key, ttlSeconds, jti) => {
    const jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt()
        .setIssuer(settings.jwt.issuer)
        .setExpirationTime(`${ttlSeconds}s`);
    if (jti) jwt.setJti(jti);
    return jwt.sign(key);
};

const verify = async (token, key, expectedTyp) => {
    const { payload } = await jwtVerify(token, key, {
        issuer: settings.jwt.issuer,
        algorithms: ['HS256'],
        clockTolerance: 5,
    });
    if (payload.typ !== expectedTyp) throw new Error('typ inesperado');
    return payload;
};

export const signAccessToken = ({ uid, rol }) =>
    sign({ uid, rol: rol ?? 'User', typ: 'access' }, accessKey, settings.jwt.accessTtlSeconds);

export const verifyAccessToken = (token) => verify(token, accessKey, 'access');

export const signResetToken = (uid, jti) =>
    sign({ uid, typ: 'reset' }, resetKey, settings.jwt.resetTtlSeconds, jti);

export const verifyResetToken = (token) => verify(token, resetKey, 'reset');

// Enlace de descarga de vida corta (60 s) para el DownloadManager de Android, que no puede
// enviar el Bearer. Lleva el usuario y una referencia al archivo; al usarlo se vuelve a
// comprobar el permiso.
export const DOWNLOAD_LINK_TTL_SECONDS = 60;

export const signDownloadToken = (uid, ref) =>
    sign({ uid, ref, typ: 'download' }, accessKey, DOWNLOAD_LINK_TTL_SECONDS);

export const verifyDownloadToken = (token) => verify(token, accessKey, 'download');

// --- Refresh tokens ---------------------------------------------------------

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const generateRefreshToken = () => {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: sha256(token) };
};

// --- Codigos de 6 digitos ---------------------------------------------------

export const generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

// Un codigo de 6 digitos tiene solo un millon de valores: un SHA-256 simple se
// revierte al instante si se filtra la BD. El HMAC con el secreto del servidor,
// atado al correo y al proposito, impide precalcular una tabla y reutilizar el
// hash de un flujo en otro.
export const hashCode = (purpose, email, code) =>
    createHmac('sha256', settings.jwt.secret).update(`${purpose}:${email}:${code}`).digest('hex');

export const safeEqual = (a, b) => {
    const left = Buffer.from(String(a ?? ''));
    const right = Buffer.from(String(b ?? ''));
    return left.length === right.length && timingSafeEqual(left, right);
};

export const newId = () => randomUUID();
