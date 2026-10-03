import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { del, incrWindow, peekWindow } from '#Libs/kv.js';

// Contador de contraseñas incorrectas por correo, compartido por el login y por
// las acciones que piden la contraseña actual (cambiar contraseña, borrar la
// cuenta): sin esto, alguien con un token robado podria adivinar la contraseña
// por esas rutas sin tocar el limite del login.
//
// Solo cuentan los FALLOS, y un acierto reinicia el contador. Superado el tope se
// rechaza hasta la ventana siguiente, incluso con la contraseña correcta, para que
// el bloqueo no sirva de oraculo.

const key = (email) => `login-fail:${email}`;

export const assertNotLocked = async (email) => {
    const failures = await peekWindow(key(email));
    if (failures.count >= settings.auth.loginMaxFailures) {
        throw ApiError.tooManyRequests(failures.ttl, 'Demasiados intentos fallidos. Intenta de nuevo más tarde.');
    }
};

export const recordFailure = (email) => incrWindow(key(email), settings.auth.loginFailureWindowSeconds);

export const clearFailures = (email) => del(key(email));
