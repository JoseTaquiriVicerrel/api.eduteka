import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize from '#Middlewares/authorize.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import validate from '#Middlewares/validate.js';
import * as controller from './download.controller.js';
import { LinkParams, ListDownloadsQuery, OrderFileParams, RedeemQuery } from './download.schemas.js';

const router = Router();
const members = [authenticate, authorize()];

router.get('/', ...members, validate(ListDownloadsQuery, 'query'), controller.list);

// Archivo comprado: exige un pedido VERIFICADO del propio usuario.
router.get('/pedidos/:order_id/:product_id/:file', ...members, rateLimit('write'), validate(OrderFileParams, 'params'), controller.orderFile);

// Enlace de vida corta para el DownloadManager (que no envia el Bearer). No lleva
// authenticate: el token firmado ES la autorizacion y se vuelve a validar al canjearlo.
router.get('/archivo', rateLimit('write'), validate(RedeemQuery, 'query'), controller.redeemLink);
router.post('/:id/enlace', ...members, rateLimit('write'), validate(LinkParams, 'params'), controller.createLink);

export default router;
