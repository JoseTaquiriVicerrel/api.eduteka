import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize, { requireCapability } from '#Middlewares/authorize.js';
import { CAPABILITIES } from '#Libs/capabilities.js';
import { dashboard } from './progress.controller.js';

const router = Router();

// El docente no responde preguntas ni rinde simulacros: no acumula progreso.
router.get('/', authenticate, authorize(), requireCapability(CAPABILITIES.TRACK_PROGRESS), dashboard);

export default router;
