import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize from '#Middlewares/authorize.js';
import parseMultipartFields from '#Middlewares/parse_multipart_fields.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import { captureUpload } from '#Middlewares/upload_capture.js';
import validate from '#Middlewares/validate.js';
import * as controller from './store.controller.js';
import { CheckoutBody, ListOrdersQuery, ListProductsQuery, OrderParams, ResolveCartBody, SlugParams } from './store.schemas.js';

const members = [authenticate, authorize()];

// /productos: catalogo publico.
export const productRouter = Router();
productRouter.get('/', validate(ListProductsQuery, 'query'), controller.listProducts);
productRouter.get('/:slug', validate(SlugParams, 'params'), controller.getProduct);

// /tienda: el carrito vive en el cliente; el servidor solo lo recalcula y registra el pedido.
export const storeRouter = Router();
storeRouter.post('/carrito/resolver', validate(ResolveCartBody), controller.resolveCart);
storeRouter.post(
    '/checkout',
    ...members,
    rateLimit('write'),
    captureUpload(['payment_proof']),
    parseMultipartFields({ json: ['items'], number: ['expected_total'] }),
    validate(CheckoutBody),
    controller.checkout,
);

// /pedidos: los del propio usuario.
export const orderRouter = Router();
orderRouter.get('/', ...members, validate(ListOrdersQuery, 'query'), controller.listOrders);
orderRouter.get('/:id', ...members, validate(OrderParams, 'params'), controller.getOrder);
