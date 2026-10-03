import { asyncHandler } from '#Libs/async_handler.js';
import { created, noContent, ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import * as lists from './list.service.js';

export const index = asyncHandler(async (req, res) => {
    const { items, total } = await lists.listOwn({
        user: req.user,
        questionId: req.query.question_id ?? null,
        page: req.query.page,
        limit: req.query.limit,
    });
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});

export const create = asyncHandler(async (req, res) => created(res, await lists.createList({ user: req.user, body: req.body })));

export const show = asyncHandler(async (req, res) => ok(res, await lists.getOwn({ user: req.user, id: req.params.id })));

export const update = asyncHandler(async (req, res) =>
    ok(res, await lists.updateList({ user: req.user, id: req.params.id, body: req.body })));

export const destroy = asyncHandler(async (req, res) => {
    await lists.deleteList({ user: req.user, id: req.params.id });
    return noContent(res);
});

export const pdf = asyncHandler(async (req, res) => {
    const { buffer, filename } = await lists.buildPdf({
        user: req.user, id: req.params.id, includeAnswers: req.query.include_answers === true,
    });
    // `attachment()` fija Content-Disposition (con el nombre codificado) y el Content-Type por la extension.
    res.attachment(filename);
    return res.send(buffer);
});

export const addQuestion = asyncHandler(async (req, res) =>
    created(res, await lists.addQuestion({ user: req.user, id: req.params.id, questionId: req.body.question_id })));

export const removeQuestion = asyncHandler(async (req, res) =>
    ok(res, await lists.removeQuestion({ user: req.user, id: req.params.id, questionId: req.params.question_id })));
