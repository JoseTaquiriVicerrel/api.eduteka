import { asyncHandler } from '#Libs/async_handler.js';
import { created, ok } from '#Libs/envelope.js';
import * as subscriptions from './subscription.service.js';

export const listPlans = asyncHandler(async (req, res) => ok(res, await subscriptions.listPlans(req.user)));

export const getPlan = asyncHandler(async (req, res) =>
    ok(res, await subscriptions.getPlan({ slug: req.params.slug, user: req.user })));

export const subscribe = asyncHandler(async (req, res) =>
    created(res, await subscriptions.subscribe({ req, user: req.user, slug: req.params.slug, body: req.body, capture: req.capture })));

export const renew = asyncHandler(async (req, res) =>
    created(res, await subscriptions.renew({ req, user: req.user, body: req.body, capture: req.capture })));

export const status = asyncHandler(async (req, res) => ok(res, await subscriptions.getStatus(req.user)));
