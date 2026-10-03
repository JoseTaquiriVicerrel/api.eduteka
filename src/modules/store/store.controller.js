import { asyncHandler } from '#Libs/async_handler.js';
import { created, ok } from '#Libs/envelope.js';
import { pageMeta } from '#Libs/paginate.js';
import * as store from './store.service.js';

export const listProducts = asyncHandler(async (req, res) => {
    const { items, total } = await store.listProducts(req.query);
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});

export const getProduct = asyncHandler(async (req, res) => ok(res, await store.getProduct(req.params.slug)));

export const resolveCart = asyncHandler(async (req, res) => ok(res, await store.resolveCart(req.body.items)));

export const checkout = asyncHandler(async (req, res) =>
    created(res, await store.checkout({ req, user: req.user, body: req.body, capture: req.capture })));

export const listOrders = asyncHandler(async (req, res) => {
    const { items, total } = await store.listOrders({ user: req.user, ...req.query });
    return ok(res, items, pageMeta({ page: req.query.page, limit: req.query.limit, total }));
});

export const getOrder = asyncHandler(async (req, res) => ok(res, await store.getOrder({ user: req.user, id: req.params.id })));
