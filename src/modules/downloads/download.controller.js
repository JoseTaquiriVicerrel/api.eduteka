import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import { logDownload, resolveExamFile, resolveOrderFile } from './download.access.js';
import { sendFile } from './download.files.js';
import * as downloads from './download.service.js';

// Envia un archivo ya autorizado y deja constancia. El registro va SIN await: la
// auditoria no puede retrasar ni romper la entrega.
const deliver = async (req, res, user, { stored, downloadName, audit }) => {
    void logDownload(req, user, audit);
    await sendFile(res, stored.absolute, downloadName);
};

export const list = asyncHandler(async (req, res) => {
    if (req.query.source === 'exam') {
        const { items, total } = await downloads.listExamFiles(req.user, req.query);
        return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
    }
    const { items, total } = await downloads.listOrderFiles(req.user);
    return ok(res, items, { total });
});

export const orderFile = asyncHandler(async (req, res) => {
    const { order_id: orderId, product_id: productId, file: fileName } = req.params;
    await deliver(req, res, req.user, await resolveOrderFile({ user: req.user, orderId, productId, fileName }));
});

export const examFile = asyncHandler(async (req, res) => {
    await deliver(req, res, req.user, await resolveExamFile({ user: req.user, slug: req.params.slug, area: req.query.area }));
});

export const createLink = asyncHandler(async (req, res) =>
    ok(res, await downloads.createDownloadLink({ user: req.user, id: req.params.id })));

// Sin Bearer: la autorizacion es el token firmado (60 s), que se vuelve a validar aqui.
export const redeemLink = asyncHandler(async (req, res) => {
    const resolved = await downloads.redeemDownloadLink(req.query.token);
    await deliver(req, res, resolved.user, resolved);
});

export const resources = asyncHandler(async (req, res) => ok(res, await downloads.getResources(req.user)));
