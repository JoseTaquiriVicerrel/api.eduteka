import { Router } from 'express';
import authenticate from '#Middlewares/authenticate.js';
import authorize from '#Middlewares/authorize.js';
import { emailKey, rateLimit } from '#Middlewares/rate_limit.js';
import validate from '#Middlewares/validate.js';
import * as controller from './auth.controller.js';
import {
    LoginBody, LogoutBody, RecoverBody, RefreshBody, RegisterBody, ResendCodeBody,
    ResetPasswordBody, VerifyCodeBody, VerifyRecoveryCodeBody,
} from './auth.schemas.js';

const router = Router();

// El correo se normaliza (recorte + minusculas) ANTES de validar y de contar el
// limite por correo, para que "A@x.com" y "a@x.com" sean la misma cuenta y el
// mismo cupo. Los usuarios se guardan en minusculas (user_schema.js).
const normalizeEmail = (req, res, next) => {
    if (typeof req.body?.email === 'string') req.body.email = req.body.email.trim().toLowerCase();
    next();
};

const perIp = rateLimit('auth');
const perEmail = rateLimit('auth-email', { key: emailKey });

router.post('/register', perIp, normalizeEmail, perEmail, validate(RegisterBody), controller.register);
router.post('/resend-code', perIp, normalizeEmail, perEmail, validate(ResendCodeBody), controller.resendCode);
router.post('/verify-code', perIp, normalizeEmail, validate(VerifyCodeBody), controller.verifyCode);
router.post('/login', perIp, normalizeEmail, validate(LoginBody), controller.login);
router.post('/refresh', perIp, validate(RefreshBody), controller.refresh);
router.post('/logout', authenticate, authorize(), validate(LogoutBody), controller.logout);
router.post('/recover', perIp, normalizeEmail, perEmail, validate(RecoverBody), controller.recover);
router.post('/verify-recovery-code', perIp, normalizeEmail, validate(VerifyRecoveryCodeBody), controller.verifyRecoveryCode);
router.post('/reset-password', perIp, validate(ResetPasswordBody), controller.resetPassword);
router.get('/me', authenticate, authorize(), controller.me);

export default router;
