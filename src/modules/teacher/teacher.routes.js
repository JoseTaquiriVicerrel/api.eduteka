import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize from '#Middlewares/authorize.js';
import * as controller from './teacher.controller.js';

const router = Router();

// Solo cuentas de Profesor (el administrador tambien pasa, como en el resto de la API).
router.get('/resumen', authenticate, authorize('Profesor'), controller.summary);

export default router;
