import { asyncHandler } from '#Libs/async_handler.js';
import { noContent, ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import { listAttempts } from '#Modules/progress/attempts.service.js';
import * as profile from './profile.service.js';

export const get = asyncHandler(async (req, res) => ok(res, await profile.getProfile(req.user._id)));

export const update = asyncHandler(async (req, res) => ok(res, await profile.updateProfile(req.user._id, req.body)));

export const changePassword = asyncHandler(async (req, res) => ok(res, await profile.changePassword(req.user._id, req.body)));

export const remove = asyncHandler(async (req, res) => {
    await profile.deleteAccount(req.user._id, req.body);
    return noContent(res);
});

export const avatar = asyncHandler(async (req, res) => ok(res, await profile.updateAvatar(req.user._id, req.file.buffer)));

export const attempts = asyncHandler(async (req, res) => {
    const { items, total } = await listAttempts({
        userId: req.user._id,
        type: req.query.type ?? null,
        page: req.query.page,
        limit: req.query.limit,
    });
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});
