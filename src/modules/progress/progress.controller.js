import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';
import { getProgress } from './progress.service.js';

export const dashboard = asyncHandler(async (req, res) => ok(res, await getProgress(req.user._id)));
