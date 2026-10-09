import { ApiError } from '#Libs/api_error.js';

// bcrypt solo lee los primeros 72 BYTES de la contraseña (no caracteres: una tilde son 2 bytes y
// un emoji 4). Una mas larga se recortaria sin avisar, y dos contraseñas distintas con el mismo
// inicio valdrian igual. Se rechaza en vez de aceptarla.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const assertPasswordBytes = (password, field = 'password') => {
    if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
        throw ApiError.validation([{ field, message: 'La contraseña es demasiado larga (máximo 72 bytes; las tildes y los emojis ocupan más de uno).' }]);
    }
};
