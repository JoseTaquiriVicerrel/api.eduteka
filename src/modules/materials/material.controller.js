import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import { logDownload } from '#Modules/downloads/download.access.js';
import { sendFile } from '#Modules/downloads/download.files.js';
import * as materials from './material.service.js';

export const list = asyncHandler(async (req, res) => {
    const { items, total, quota } = await materials.listMaterials({ user: req.user, page: req.query.page, limit: req.query.limit });
    return ok(res, items, { ...pageMeta({ page: req.query.page, limit: req.query.limit, total }), quota });
});

export const download = asyncHandler(async (req, res) => {
    const { stored, downloadName, audit } = await materials.resolveMaterialFile({ user: req.user, id: req.params.id });
    // La auditoria no retrasa ni rompe la entrega.
    void logDownload(req, req.user, audit);
    await sendFile(res, stored.absolute, downloadName);
});
