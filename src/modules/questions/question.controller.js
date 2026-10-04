import { asyncHandler } from '#Libs/async_handler.js';
import { created, ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import * as questions from './question.service.js';

export const list = asyncHandler(async (req, res) => {
    const { items, total, answers_visible: answersVisible } = await questions.listQuestions({ ...req.query, user: req.user });
    const meta = pageMeta({ page: req.query.page, limit: req.query.limit, total });
    return ok(res, items, answersVisible ? { ...meta, answers_visible: true } : meta);
});

export const topics = asyncHandler(async (req, res) => ok(res, await questions.getTopics({
    area: req.query.area,
    institution: req.query.institution ?? null,
    withResolution: req.query.with_resolution === true,
})));

export const detail = asyncHandler(async (req, res) => ok(res, await questions.getQuestion(req.params.id, req.user)));

export const answer = asyncHandler(async (req, res) => ok(res, await questions.answerQuestion({
    user: req.user,
    questionId: req.params.id,
    selected: req.body.selected,
})));

export const report = asyncHandler(async (req, res) => created(res, await questions.reportQuestion({
    userId: req.user._id,
    questionId: req.params.id,
    type: req.body.type,
    description: req.body.description,
})));
