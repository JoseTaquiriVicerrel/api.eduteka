import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { asyncHandler } from '#Libs/async_handler.js';
import { incrWindow } from '#Libs/kv.js';

// Rate limit de ventana fija (especificacion §3.4). Redis compartido y, si se
// cae, memoria del proceso (#Libs/kv.js).
//
//   global      todo                             por IP
//   auth        login/registro/refresh/recuperar por IP
//   auth-email  registro y envio de codigos      por correo
//   write       respuestas, autoguardado, pagos  por usuario
//
// El login cuenta ademas SUS fallos por correo aparte (ver auth.service.js): asi
// quien acierta la contraseña no consume el cupo de intentos de esa cuenta.

export const BUCKETS = Object.freeze({
    global: { limit: settings.rateLimit.global, windowSeconds: 60 },
    auth: { limit: settings.rateLimit.auth, windowSeconds: 60 },
    'auth-email': { limit: settings.rateLimit.authEmail, windowSeconds: 15 * 60 },
    write: { limit: settings.rateLimit.write, windowSeconds: 60 },
});

const defaultKey = (req) => req.user?._id ?? req.ip;

/**
 * @param {keyof typeof BUCKETS} bucket
 * @param {{ key?: (req) => string|undefined, skip?: (req) => boolean }} [options]
 */
export function rateLimit(bucket, { key = defaultKey, skip } = {}) {
    const config = BUCKETS[bucket];
    if (!config) throw new Error(`rateLimit: bucket desconocido "${bucket}"`);

    return asyncHandler(async (req, res, next) => {
        if (skip?.(req)) return next();

        const identity = key(req) ?? req.ip;
        const { count, ttl } = await incrWindow(`rl:${bucket}:${identity}`, config.windowSeconds);

        res.set({
            'RateLimit-Limit': String(config.limit),
            'RateLimit-Remaining': String(Math.max(0, config.limit - count)),
            'RateLimit-Reset': String(ttl),
        });

        if (count > config.limit) throw ApiError.tooManyRequests(ttl);
        return next();
    });
}

/** Clave por correo (en minusculas) para el bucket `auth-email`. */
export const emailKey = (req) => {
    const email = req.body?.email;
    return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : req.ip;
};
