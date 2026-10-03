import { asyncHandler } from '#Libs/async_handler.js';
import { created, ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import { getTopics } from '#Modules/questions/question.service.js';
import * as practices from './practice.service.js';

export const areaTopics = asyncHandler(async (req, res) => ok(res, await getTopics({
    area: req.query.area,
    institution: req.query.institution ?? null,
    withResolution: req.query.with_resolution === true,
})));

export const areaQuestions = asyncHandler(async (req, res) => {
    const { questions, meta } = await practices.generateAreaPractice({
        user: req.user,
        area: req.query.area,
        topic: req.query.topic ?? null,
        difficulty: req.query.difficulty ?? null,
        institution: req.query.institution ?? null,
        count: req.query.count,
        withResolution: req.query.with_resolution === true,
    });
    return ok(res, questions, meta);
});

// Primer cierre -> 201; reenvio del mismo cierre -> 200 con el mismo intento.
const respond = (res, { replay, result }) => (replay ? ok(res, result) : created(res, result));

export const finalizeArea = asyncHandler(async (req, res) =>
    respond(res, await practices.finalizeAreaPractice({ user: req.user, body: req.body })));

export const list = asyncHandler(async (req, res) => {
    const { items, total } = await practices.listPractices(req.query);
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});

export const detail = asyncHandler(async (req, res) =>
    ok(res, await practices.getPractice({ slug: req.params.slug, user: req.user })));

export const finalize = asyncHandler(async (req, res) =>
    respond(res, await practices.finalizePractice({ user: req.user, slug: req.params.slug, body: req.body })));
