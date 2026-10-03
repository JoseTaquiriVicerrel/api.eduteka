import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { isPremium } from '#Libs/capabilities.js';
import { incrWindow, peekWindow } from '#Libs/kv.js';
import { DAY_MS, startOfDay, toInputDate } from '#Libs/lima_time.js';

// Cupo diario de respuestas NUEVAS para cuentas sin suscripcion vigente
// (FREE_DAILY_ANSWER_LIMIT, 0 = sin limite). El dia es el de Lima. Cambiar una
// respuesta ya registrada no consume cupo.
//
// Lo comparten /preguntas/:id/responder y el cierre de las practicas: si solo se
// comprobara en el primero, bastaria con enviar las respuestas todas juntas al
// final de una practica para saltarse el limite.

const key = (userId, now) => `daily-answers:${userId}:${toInputDate(now)}`;

const secondsUntilNextLimaDay = (now) =>
    Math.max(1, Math.ceil((startOfDay(now).getTime() + DAY_MS - now.getTime()) / 1000));

export const hasQuota = (user, now = new Date()) => settings.limits.freeDailyAnswers > 0 && !isPremium(user, now);

/** Respuestas nuevas que aun puede registrar hoy (Infinity si no tiene limite). */
export const remainingQuota = async (user, now = new Date()) => {
    if (!hasQuota(user, now)) return Infinity;
    const { count } = await peekWindow(key(user._id, now));
    return Math.max(0, settings.limits.freeDailyAnswers - count);
};

/** Lanza 403 SUBSCRIPTION_REQUIRED si `needed` respuestas nuevas no caben en el cupo. */
export const assertQuota = async (user, needed = 1, now = new Date()) => {
    if (needed <= 0 || !hasQuota(user, now)) return;
    if ((await remainingQuota(user, now)) < needed) {
        throw ApiError.subscriptionRequired(
            `Llegaste al límite de ${settings.limits.freeDailyAnswers} respuestas diarias. Suscríbete para seguir practicando.`,
        );
    }
};

export const consumeQuota = async (user, amount, now = new Date()) => {
    if (amount <= 0 || !hasQuota(user, now)) return;
    await incrWindow(key(user._id, now), secondsUntilNextLimaDay(now), amount);
};
