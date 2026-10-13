import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import * as readings from './reading.service.js';

export const list = asyncHandler(async (req, res) => {
    const { items, total } = await readings.listReadings(req.query);
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});

export const areas = asyncHandler(async (req, res) => ok(res, await readings.listReadingAreas()));

export const detail = asyncHandler(async (req, res) =>
    ok(res, await readings.getReading({ slug: req.params.slug, user: req.user })));
