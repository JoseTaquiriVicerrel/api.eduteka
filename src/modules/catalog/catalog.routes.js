import { Router } from 'express';
import validate from '#Middlewares/validate.js';
import { AreasQuery } from './catalog.schemas.js';
import * as controller from './catalog.controller.js';

const router = Router();

// Catalogos publicos: cambian poco y no dependen del usuario, asi que se pueden
// cachear unos minutos (Express añade el ETag y responde 304 si no cambiaron).
const publicCache = (req, res, next) => {
    res.set('Cache-Control', 'public, max-age=300');
    next();
};

router.get('/instituciones', publicCache, controller.institutions);
router.get('/areas', publicCache, validate(AreasQuery, 'query'), controller.areas);

export default router;
