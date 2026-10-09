import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { del, incrWindow, peekWindow } from '#Libs/kv.js';

// Contador de contraseñas incorrectas, compartido por el login y por las acciones que piden
// la contraseña actual (cambiar contraseña, borrar la cuenta): sin esto, alguien con un token
// robado podria adivinar la contraseña por esas rutas sin tocar el limite del login.
//
// Dos contadores por correo:
//  - por correo + IP (LOGIN_MAX_FAILURES, 5): frena a quien adivina desde un mismo lugar sin
//    dejar fuera al dueño de la cuenta, que entra desde otra IP;
//  - por correo en total (LOGIN_MAX_FAILURES_PER_EMAIL, 30): frena un ataque repartido entre
//    muchas IP. Es alto a proposito: bloquear a una victima exige 30 fallos, no 5.
//
// Solo cuentan los FALLOS, y un acierto reinicia el contador de ese correo + IP. Superado el
// tope se rechaza hasta la ventana siguiente, incluso con la contraseña correcta, para que
// el bloqueo no sirva de oraculo.

const pairKey = (email, ip) => `login-fail:${email}:${ip ?? 'sin-ip'}`;
const emailKey = (email) => `login-fail-email:${email}`;

const locked = (ttl) => ApiError.tooManyRequests(ttl, 'Demasiados intentos fallidos. Intenta de nuevo más tarde.');

export const assertNotLocked = async (email, ip) => {
    const [pair, total] = await Promise.all([peekWindow(pairKey(email, ip)), peekWindow(emailKey(email))]);
    if (pair.count >= settings.auth.loginMaxFailures) throw locked(pair.ttl);
    if (total.count >= settings.auth.loginMaxFailuresPerEmail) throw locked(total.ttl);
};

export const recordFailure = (email, ip) => Promise.all([
    incrWindow(pairKey(email, ip), settings.auth.loginFailureWindowSeconds),
    incrWindow(emailKey(email), settings.auth.loginFailureWindowSeconds),
]);

export const clearFailures = (email, ip) => del(pairKey(email, ip));
