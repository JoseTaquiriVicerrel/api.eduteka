import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import * as exams from './exam.service.js';

export const list = asyncHandler(async (req, res) => {
    const { items, total } = await exams.listExams(req.query);
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});

export const detail = asyncHandler(async (req, res) =>
    ok(res, await exams.getExam({ slug: req.params.slug, area: req.query.area, user: req.user })));

export const favorite = asyncHandler(async (req, res) =>
    ok(res, await exams.setFavorite({ user: req.user, examId: req.params.id, favorite: req.body.favorite })));

export const favorites = asyncHandler(async (req, res) => {
    const { items, total } = await exams.listFavorites({ user: req.user, page: req.query.page, limit: req.query.limit });
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});
