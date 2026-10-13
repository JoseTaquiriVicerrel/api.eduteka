import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import validate from '#Middlewares/validate.js';
import * as controller from './reading.controller.js';
import { ListReadingsQuery, ReadingAreasQuery, ReadingParams } from './reading.schemas.js';

const router = Router();

// Catalogo publico, como /lecturas de la web.
router.get('/', validate(ListReadingsQuery, 'query'), controller.list);

// OJO con el orden: `/areas` tiene que registrarse antes que `/:slug`.
router.get('/areas', validate(ReadingAreasQuery, 'query'), controller.areas);

// La lectura es publica; con sesion de docente trae las respuestas. Se responde con POST /preguntas/:id/responder.
router.get('/:slug', authenticate, validate(ReadingParams, 'params'), controller.detail);

export default router;
