import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize, { requireCapability } from '#Middlewares/authorize.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import uploadCapture from '#Middlewares/upload_capture.js';
import validate from '#Middlewares/validate.js';
import { CAPABILITIES } from '#Libs/capabilities.js';
import * as controller from './simulacrum.controller.js';
import {
    AttemptParams, EnrollBody, FinalizeBody, ListSimulacraQuery, SaveAnswersBody, SlugParams, SolucionarioQuery,
} from './simulacrum.schemas.js';

const router = Router();

// Rendir un simulacro (inscribirse, iniciar, responder, reintentar) es solo del
// estudiante. El docente ve la ficha y los resultados, y con suscripcion el solucionario.
const takers = [authenticate, authorize(), requireCapability(CAPABILITIES.TAKE_SIMULACRUM)];
const members = [authenticate, authorize()];

// Publico: catalogo y ficha (con sesion marcan la inscripcion).
router.get('/', authenticate, validate(ListSimulacraQuery, 'query'), controller.list);

// El intento se identifica por el id de la inscripcion (el intento vivo vive en ella).
// Se registran antes que las rutas `/:slug/...`.
router.put(
    '/intentos/:attempt_id/respuestas',
    ...takers,
    rateLimit('write'),
    validate(AttemptParams, 'params'),
    validate(SaveAnswersBody),
    controller.saveAnswers,
);
router.post(
    '/intentos/:attempt_id/finalizar',
    ...takers,
    rateLimit('write'),
    validate(AttemptParams, 'params'),
    validate(FinalizeBody),
    controller.finish,
);

router.get('/:slug', authenticate, validate(SlugParams, 'params'), controller.detail);
router.post(
    '/:slug/inscribirme',
    ...takers,
    rateLimit('write'),
    uploadCapture,
    validate(SlugParams, 'params'),
    validate(EnrollBody),
    controller.enroll,
);
router.post('/:slug/iniciar', ...takers, rateLimit('write'), validate(SlugParams, 'params'), controller.start);
router.post('/:slug/reintentar', ...takers, rateLimit('write'), validate(SlugParams, 'params'), controller.retry);
router.get('/:slug/resultados', ...members, validate(SlugParams, 'params'), controller.results);
router.get('/:slug/solucionario', ...members, validate(SlugParams, 'params'), validate(SolucionarioQuery, 'query'), controller.solucionario);

export default router;
