import UserModel from '#Models/user_model.js';
import { asyncHandler } from '#Libs/async_handler.js';
import { verifyAccessToken } from '#Libs/tokens.js';

// Campos del usuario que necesitan las rutas autenticadas y el serializador.
// Nunca incluye password ni codigos.
export const AUTH_USER_FIELDS = {
    _id: 1,
    email: 1,
    username: 1,
    fullname: 1,
    rol: 1,
    account_type: 1,
    departament: 1,
    university: 1,
    teaching_area: 1,
    avatar: 1,
    notification: 1,
    isVerified: 1,
    state: 1,
    suscription: 1,
    created_at: 1,
};

/**
 * Resuelve al usuario del Bearer. NUNCA corta la peticion: deja `req.user` (o
 * null) y, si hubo un problema, `req.authError` ('missing' | 'invalid' |
 * 'disabled'). Las rutas privadas usan `authorize()`, que es quien responde 401
 * o 403. Asi una ruta publica sigue funcionando con un token vencido en el
 * dispositivo, y una privada da 401 y la app hace refresh.
 */
export default asyncHandler(async function authenticate(req, res, next) {
    req.user = null;
    req.authError = 'missing';

    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return next();

    let payload;
    try {
        payload = await verifyAccessToken(match[1]);
    } catch {
        req.authError = 'invalid';
        return next();
    }

    const user = await UserModel.findById(payload.uid, AUTH_USER_FIELDS).lean().exec();
    if (!user) {
        req.authError = 'invalid';
        return next();
    }
    if (user.state === false) {
        req.authError = 'disabled';
        return next();
    }

    req.user = user;
    req.authError = null;
    return next();
});
