import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize, { requireCapability } from '#Middlewares/authorize.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import validate from '#Middlewares/validate.js';
import { CAPABILITIES } from '#Libs/capabilities.js';
import * as controller from './question.controller.js';
import { AnswerBody, ListQuestionsQuery, QuestionParams, ReportBody, TopicsQuery } from './question.schemas.js';

const router = Router();

// Lectura publica: el postulante puede explorar el banco antes de crear cuenta. `authenticate`
// no corta: solo identifica a quien pregunta (el docente recibe la clave y la explicacion).
// OJO con el orden: `/temas` tiene que registrarse antes que `/:id`.
router.get('/', authenticate, validate(ListQuestionsQuery, 'query'), controller.list);
router.get('/temas', validate(TopicsQuery, 'query'), controller.topics);
router.get('/:id', authenticate, validate(QuestionParams, 'params'), controller.detail);

// Responder exige sesion y una cuenta que practique (las de docente ven la
// respuesta directamente y no acumulan progreso).
router.post(
    '/:id/responder',
    authenticate,
    authorize(),
    requireCapability(CAPABILITIES.ANSWER_QUESTIONS),
    rateLimit('write'),
    validate(QuestionParams, 'params'),
    validate(AnswerBody),
    controller.answer,
);

// Reportar un error de la pregunta lo puede hacer cualquier cuenta con sesion.
router.post(
    '/:id/reportar',
    authenticate,
    authorize(),
    rateLimit('write'),
    validate(QuestionParams, 'params'),
    validate(ReportBody),
    controller.report,
);

export default router;
