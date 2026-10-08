import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';
import { getTeacherSummary } from './teacher.service.js';

export const summary = asyncHandler(async (req, res) => ok(res, await getTeacherSummary(req.user)));
