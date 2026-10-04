import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize from '#Middlewares/authorize.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import { captureUpload } from '#Middlewares/upload_capture.js';
import validate from '#Middlewares/validate.js';
import * as controller from './subscription.controller.js';
import { SlugParams, SubscribeBody } from './subscription.schemas.js';

const router = Router();
const members = [authenticate, authorize()];
// Comprobante en `payment_proof` (contrato) o `payment_capture` (nombre de la web).
const uploadProof = captureUpload(['payment_proof', 'payment_capture']);

// Publico: con sesion marcan el plan actual, el pago pendiente y la renovacion.
router.get('/', authenticate, controller.listPlans);

// Rutas fijas antes que `/:slug`.
router.get('/estado', ...members, controller.status);

router.get('/:slug', authenticate, validate(SlugParams, 'params'), controller.getPlan);
router.post(
    '/:slug/suscribirme',
    ...members,
    rateLimit('write'),
    uploadProof,
    validate(SlugParams, 'params'),
    validate(SubscribeBody),
    controller.subscribe,
);

export default router;
