import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize from '#Middlewares/authorize.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import validate from '#Middlewares/validate.js';
import { examFile } from '../downloads/download.controller.js';
import { ExamPdfParams, ExamPdfQuery } from '../downloads/download.schemas.js';
import * as controller from './exam.controller.js';
import {
    ExamDetailQuery, ExamIdParams, ExamSlugParams, FavoriteBody, FavoritesQuery, ListExamsQuery,
} from './exam.schemas.js';

const router = Router();

// El catalogo es publico.
router.get('/', validate(ListExamsQuery, 'query'), controller.list);

// OJO con el orden: `/favoritos` tiene que registrarse antes que `/:slug`.
router.get('/favoritos', authenticate, authorize(), validate(FavoritesQuery, 'query'), controller.favorites);

// El detalle es publico; con sesion marca si es favorito y, para docentes y
// suscriptores, no aplica la vista previa.
router.get('/:slug', authenticate, validate(ExamSlugParams, 'params'), validate(ExamDetailQuery, 'query'), controller.detail);

// PDF del examen (con suscripcion vigente). Va por el controlador de descargas, que comprueba
// el permiso y la institucion del plan: el archivo nunca se sirve de forma estatica.
router.get(
    '/:slug/pdf',
    authenticate,
    authorize(),
    rateLimit('write'),
    validate(ExamPdfParams, 'params'),
    validate(ExamPdfQuery, 'query'),
    examFile,
);

router.post(
    '/:id/favorito',
    authenticate,
    authorize(),
    rateLimit('write'),
    validate(ExamIdParams, 'params'),
    validate(FavoriteBody),
    controller.favorite,
);

export default router;
