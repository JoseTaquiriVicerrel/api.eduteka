import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';
import * as catalog from './catalog.service.js';

export const institutions = asyncHandler(async (req, res) => ok(res, await catalog.listInstitutions()));

export const areas = asyncHandler(async (req, res) => ok(res, await catalog.listAreas({
    institution: req.query.institution ?? null,
    withResolution: req.query.with_resolution === true,
})));
