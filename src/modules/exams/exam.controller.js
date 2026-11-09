import { asyncHandler } from '#Libs/async_handler.js';
import { ApiError } from '#Libs/api_error.js';
import { ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import * as exams from './exam.service.js';
import { getExamExtras } from './exam.extras.js';

export const list = asyncHandler(async (req, res) => {
    const { items, total } = await exams.listExams(req.query);
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});

export const modalities = asyncHandler(async (req, res) => ok(res, await exams.listModalities(req.query)));

export const detail = asyncHandler(async (req, res) => {
    // El detalle es publico, pero un Bearer vencido NO debe degradarse a "anonimo": la app recibiria la ficha sin
    // preguntas (login_required) con 200 y nunca renovaria el token (p. ej. al abrir el enlace de un correo con la
    // app cerrada). Con 401 su autenticador refresca y reintenta. El cliente web no lleva Bearer de usuario.
    if (req.authError === 'invalid' && req.client !== 'web') throw ApiError.unauthenticated();
    return ok(res, await exams.getExam({ slug: req.params.slug, area: req.query.area, user: req.user, client: req.client }));
});

export const favorite = asyncHandler(async (req, res) =>
    ok(res, await exams.setFavorite({ user: req.user, examId: req.params.id, favorite: req.body.favorite })));

export const favorites = asyncHandler(async (req, res) => {
    const { items, total } = await exams.listFavorites({ user: req.user, page: req.query.page, limit: req.query.limit });
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});

export const extras = asyncHandler(async (req, res) => ok(res, await getExamExtras({ examId: req.params.id, user: req.user })));
