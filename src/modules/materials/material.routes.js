import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize from '#Middlewares/authorize.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import validate from '#Middlewares/validate.js';
import * as controller from './material.controller.js';
import { ListMaterialsQuery, MaterialParams } from './material.schemas.js';

const router = Router();

// Cualquier cuenta con sesion: lo que devuelve es solo lo suyo.
router.use(authenticate, authorize());

router.get('/', validate(ListMaterialsQuery, 'query'), controller.list);
router.get('/:id/descargar', rateLimit('write'), validate(MaterialParams, 'params'), controller.download);

export default router;
