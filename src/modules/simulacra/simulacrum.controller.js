import { asyncHandler } from '#Libs/async_handler.js';
import { created, ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import * as simulacra from './simulacrum.service.js';
import { deviceOf } from './simulacrum.session.js';

export const list = asyncHandler(async (req, res) => {
    const { items, total, server_time: serverTime } = await simulacra.listSimulacra({ ...req.query, user: req.user });
    return ok(res, items, { ...pageMeta({ page: req.query.page, limit: req.query.limit, total }), server_time: serverTime });
});

export const detail = asyncHandler(async (req, res) =>
    ok(res, await simulacra.getSimulacrumDetail({ slug: req.params.slug, user: req.user })));

export const enroll = asyncHandler(async (req, res) =>
    created(res, await simulacra.enroll({ user: req.user, slug: req.params.slug, body: req.body, capture: req.capture })));

export const start = asyncHandler(async (req, res) =>
    ok(res, await simulacra.startAttempt({ user: req.user, slug: req.params.slug, device: deviceOf(req) })));

export const heartbeat = asyncHandler(async (req, res) =>
    ok(res, await simulacra.heartbeat({ user: req.user, attemptId: req.params.attempt_id, device: deviceOf(req) })));

export const saveAnswers = asyncHandler(async (req, res) =>
    ok(res, await simulacra.saveAnswers({
        user: req.user, attemptId: req.params.attempt_id, answers: req.body.answers, attemptNumber: req.body.attempt_number, device: deviceOf(req),
    })));

export const finish = asyncHandler(async (req, res) =>
    ok(res, await simulacra.finishAttempt({
        user: req.user, attemptId: req.params.attempt_id, answers: req.body.answers, attemptNumber: req.body.attempt_number, device: deviceOf(req),
    })));

export const results = asyncHandler(async (req, res) =>
    ok(res, await simulacra.getResults({ user: req.user, slug: req.params.slug })));

export const solucionario = asyncHandler(async (req, res) =>
    ok(res, await simulacra.getSolucionario({ user: req.user, slug: req.params.slug, area: req.query.area })));

export const retry = asyncHandler(async (req, res) =>
    created(res, await simulacra.retry({ user: req.user, slug: req.params.slug })));
