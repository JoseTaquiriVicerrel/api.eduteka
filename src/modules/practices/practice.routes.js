import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize, { requireCapability } from '#Middlewares/authorize.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import validate from '#Middlewares/validate.js';
import { CAPABILITIES } from '#Libs/capabilities.js';
import { TopicsQuery } from '#Modules/questions/question.schemas.js';
import * as controller from './practice.controller.js';
import {
    AreaPracticeQuery, FinalizeAreaBody, FinalizePracticeBody, ListPracticesQuery, PracticeParams,
} from './practice.schemas.js';

// Resolver una practica exige una cuenta que practique: las de docente ven las
// practicas como material y no acumulan progreso.
const practiceAccount = [authenticate, authorize(), requireCapability(CAPABILITIES.TAKE_PRACTICE)];

// /practicas-area ---------------------------------------------------------------
export const areaRouter = Router();

// Los selectores son publicos: el postulante puede explorar que hay antes de crear cuenta.
areaRouter.get('/temas', validate(TopicsQuery, 'query'), controller.areaTopics);
// Generar una tanda es de toda cuenta con sesion: el estudiante la recibe sin clave y el docente resuelta.
areaRouter.get('/preguntas', authenticate, authorize(), validate(AreaPracticeQuery, 'query'), controller.areaQuestions);
areaRouter.post('/finalizar', ...practiceAccount, rateLimit('write'), validate(FinalizeAreaBody), controller.finalizeArea);

// /practicas --------------------------------------------------------------------
export const listRouter = Router();

listRouter.get('/', validate(ListPracticesQuery, 'query'), controller.list);
// El listado es publico, el detalle no (igual que en la web): exige sesion. Un
// dueño ve ademas sus listas privadas.
listRouter.get('/:slug', authenticate, authorize(), validate(PracticeParams, 'params'), controller.detail);
listRouter.post(
    '/:slug/finalizar',
    ...practiceAccount,
    rateLimit('write'),
    validate(PracticeParams, 'params'),
    validate(FinalizePracticeBody),
    controller.finalize,
);
