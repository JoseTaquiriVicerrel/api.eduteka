import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize from '#Middlewares/authorize.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import validate from '#Middlewares/validate.js';
import * as controller from './list.controller.js';
import {
    AddQuestionBody, CreateListBody, ListParams, ListQuestionParams, ListsQuery, PdfQuery, UpdateListBody,
} from './list.schemas.js';

const router = Router();

// Las listas personales son de cualquier cuenta con sesion (tambien docentes).
router.use(authenticate, authorize());

router.get('/', validate(ListsQuery, 'query'), controller.index);
router.post('/', rateLimit('write'), validate(CreateListBody), controller.create);
router.get('/:id', validate(ListParams, 'params'), controller.show);
router.patch('/:id', rateLimit('write'), validate(ListParams, 'params'), validate(UpdateListBody), controller.update);
router.delete('/:id', rateLimit('write'), validate(ListParams, 'params'), controller.destroy);
router.get('/:id/pdf', rateLimit('write'), validate(ListParams, 'params'), validate(PdfQuery, 'query'), controller.pdf);
router.post('/:id/preguntas', rateLimit('write'), validate(ListParams, 'params'), validate(AddQuestionBody), controller.addQuestion);
router.delete('/:id/preguntas/:question_id', rateLimit('write'), validate(ListQuestionParams, 'params'), controller.removeQuestion);

export default router;
