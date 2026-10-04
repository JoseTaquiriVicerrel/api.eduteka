import { settings } from '#Config/settings.js';
import { capabilitiesFor, hasActiveSuscription } from '#Libs/capabilities.js';
import { limitsFor } from '#Libs/plan_limits.js';

// Modelo -> JSON publico del usuario, con lista blanca de campos: el hash de la
// contrasena, los codigos de verificacion y cualquier campo interno nunca salen
// de aqui aunque el documento los traiga.

const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// Los avatares del monolito son rutas relativas a la web (/uploads/avatars/..); los
// de la API, relativas a la API (/api/v1/media/avatars/..) si no hay PUBLIC_API_URL.
const absoluteUrl = (value) => {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    const base = value.startsWith('/api/') ? (settings.app.apiUrl ?? settings.app.webUrl) : settings.app.webUrl;
    if (!base) return value;
    return `${base}${value.startsWith('/') ? '' : '/'}${value}`;
};

// Una renovación aprobada se encadena: el ciclo nuevo arranca cuando termina el vigente (./subscription.activation.js).
// Mientras ese ciclo no haya empezado, ya se hizo la única renovación permitida y no se admite otra: ni se ofrece
// (`can_renew`) ni `suscribirme` la acepta (409 RENEWAL_ALREADY_QUEUED).
export const hasQueuedRenewal = (suscription, now = new Date()) => {
    const start = suscription?.start_date ? new Date(suscription.start_date) : null;
    return Boolean(start && !Number.isNaN(start.getTime()) && start > now);
};

export const serializeSuscription = (suscription, now = new Date()) => {
    if (!suscription || typeof suscription !== 'object') return null;

    const end = suscription.end_date ? new Date(suscription.end_date) : null;
    const validEnd = end && !Number.isNaN(end.getTime()) ? end : null;

    return {
        status: suscription.status ?? null,
        active: hasActiveSuscription({ suscription }, now),
        plan_id: suscription.plan_id ?? null,
        slug: suscription.slug ?? null,
        audience: suscription.audience ?? null,
        name: suscription.name ?? null,
        start_date: iso(suscription.start_date),
        end_date: validEnd ? validEnd.toISOString() : null,
        days_remaining: validEnd ? Math.max(0, Math.ceil((validEnd - now) / DAY_MS)) : null,
        restricted_to_institution: Boolean(suscription.restricted_to_institution),
        institution_id: suscription.institution_id ?? null,
        // false: ya hay una renovación aprobada que todavía no empieza; el cliente oculta «Renovar».
        can_renew: !hasQueuedRenewal(suscription, now),
    };
};

export const serializeUser = (user, now = new Date()) => ({
    id: user._id,
    email: user.email,
    username: user.username ?? null,
    fullname: user.fullname ?? null,
    rol: user.rol ?? 'User',
    account_type: user.account_type ?? null,
    departament: user.departament ?? null,
    university: user.university ?? null,
    teaching_area: user.teaching_area ?? null,
    avatar: absoluteUrl(user.avatar),
    notification: Boolean(user.notification),
    is_verified: Boolean(user.isVerified),
    created_at: iso(user.created_at),
    suscription: serializeSuscription(user.suscription, now),
    plan_limits: limitsFor(user, now),
    capabilities: capabilitiesFor(user, now),
});
