import { ApiError } from '#Libs/api_error.js';
import { capabilitiesFor, hasActiveSuscription, isAdmin } from '#Libs/capabilities.js';

/**
 * Exige sesion y, opcionalmente, uno de los roles / tipos de cuenta indicados.
 * Va siempre DESPUES de `authenticate`.
 *
 *   authorize()                        cualquier usuario con sesion
 *   authorize('Administrador')         solo administradores
 *   authorize('Profesor')              tipo de cuenta Profesor (o administrador)
 *
 * Se admiten tanto el rol ('Administrador', 'User') como el tipo de cuenta
 * ('Estudiante', 'Profesor'): son campos distintos y sus valores no se solapan
 * (mismo criterio que authorize() del monolito). El administrador pasa siempre.
 */
export default function authorize(...allowed) {
    return function authorizeMiddleware(req, res, next) {
        if (!req.user) {
            return next(req.authError === 'disabled' ? ApiError.accountDisabled() : ApiError.unauthenticated());
        }

        if (allowed.length === 0 || isAdmin(req.user)) return next();

        const identities = [req.user.rol, req.user.account_type];
        if (!allowed.some((role) => identities.includes(role))) return next(ApiError.forbidden());

        return next();
    };
}

/**
 * Exige un plan activo. `INSTITUTION_RESTRICTED` cuando el plan esta limitado a
 * una institucion y el recurso pertenece a otra: la ruta pasa `institutionOf(req)`
 * con el id de la institucion del recurso, si aplica.
 */
export function requireSubscription({ institutionOf } = {}) {
    return function requireSubscriptionMiddleware(req, res, next) {
        if (!req.user) {
            return next(req.authError === 'disabled' ? ApiError.accountDisabled() : ApiError.unauthenticated());
        }
        if (isAdmin(req.user)) return next();
        if (!hasActiveSuscription(req.user)) return next(ApiError.subscriptionRequired());

        const { suscription } = req.user;
        if (suscription.restricted_to_institution && institutionOf) {
            const institutionId = institutionOf(req);
            if (institutionId && String(institutionId) !== String(suscription.institution_id)) {
                return next(ApiError.institutionRestricted());
            }
        }
        return next();
    };
}

/**
 * Exige una capacidad concreta (ver #Libs/capabilities.js). Va despues de
 * `authorize()`. Es lo que impide, por ejemplo, que una cuenta de docente
 * responda preguntas o rinda simulacros aunque llame al endpoint a mano.
 */
export function requireCapability(capability) {
    return function requireCapabilityMiddleware(req, res, next) {
        if (!req.user) {
            return next(req.authError === 'disabled' ? ApiError.accountDisabled() : ApiError.unauthenticated());
        }
        if (!capabilitiesFor(req.user).includes(capability)) return next(ApiError.forbidden('Tu tipo de cuenta no puede realizar esta acción.'));
        return next();
    };
}
