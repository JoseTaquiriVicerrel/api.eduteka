import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize from '#Middlewares/authorize.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import uploadAvatar from '#Middlewares/upload_avatar.js';
import validate from '#Middlewares/validate.js';
import { resources } from '../downloads/download.controller.js';
import * as controller from './profile.controller.js';
import { AttemptsQuery, ChangePasswordBody, DeleteAccountBody, UpdateProfileBody } from './profile.schemas.js';

const router = Router();

// Todo el perfil es del usuario del token.
router.use(authenticate, authorize());

router.get('/', controller.get);
router.patch('/', rateLimit('write'), validate(UpdateProfileBody), controller.update);
// Pide la contraseña actual: va ademas por el bucket `auth` (por IP) y comparte el
// limite de fallos del login.
router.post('/cambiar-password', rateLimit('auth'), validate(ChangePasswordBody), controller.changePassword);
// Borrar la cuenta lleva el cuerpo en un DELETE (Retrofit: @HTTP(method = "DELETE", hasBody = true)).
router.delete('/', rateLimit('auth'), validate(DeleteAccountBody), controller.remove);
router.post('/avatar', rateLimit('write'), uploadAvatar, controller.avatar);
router.get('/intentos', validate(AttemptsQuery, 'query'), controller.attempts);
// Compras y suscripcion; los archivos se listan y descargan por /descargas.
router.get('/recursos', resources);

export default router;
