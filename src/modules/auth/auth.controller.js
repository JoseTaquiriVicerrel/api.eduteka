import { asyncHandler } from '#Libs/async_handler.js';
import { created, noContent, ok } from '#Libs/envelope.js';
import * as auth from './auth.service.js';

// Controladores delgados: la validacion ya la hizo el middleware `validate`; aqui
// solo se llama al servicio y se responde con el envelope.

export const register = asyncHandler(async (req, res) => created(res, await auth.register(req.body)));

export const resendCode = asyncHandler(async (req, res) => ok(res, await auth.resendCode(req.body)));

export const verifyCode = asyncHandler(async (req, res) =>
    ok(res, await auth.verifyCode(req.body, auth.requestContext(req))));

export const login = asyncHandler(async (req, res) =>
    ok(res, await auth.login(req.body, auth.requestContext(req))));

export const refresh = asyncHandler(async (req, res) =>
    ok(res, await auth.refresh(req.body, auth.requestContext(req))));

export const logout = asyncHandler(async (req, res) => {
    await auth.logout(req.user._id, req.body);
    return noContent(res);
});

export const recover = asyncHandler(async (req, res) => ok(res, await auth.recover(req.body)));

export const verifyRecoveryCode = asyncHandler(async (req, res) => ok(res, await auth.verifyRecoveryCode(req.body)));

export const resetPassword = asyncHandler(async (req, res) => ok(res, await auth.resetPassword(req.body)));

export const me = (req, res) => ok(res, auth.me(req.user));
