// Error de dominio de la API. Lo lanzan servicios y middlewares; el manejador de
// errores (#Middlewares/error_handler.js) lo convierte en el envelope de error.
//
// `code` es parte del contrato con los clientes: en ingles, estable, y no se
// renombra. `message` es texto para mostrar y puede cambiar.

// Mensajes listos para mostrar cuando falta una capacidad (el cliente los pinta tal cual).
const CAPABILITY_MESSAGES = {
    answer_questions: 'Las cuentas de docente no responden preguntas: ven la respuesta directamente.',
    take_practice: 'Las cuentas de docente no resuelven prácticas: las ven resueltas.',
    take_simulacrum: 'Los simulacros son solo para cuentas de estudiante.',
    track_progress: 'El progreso es solo para cuentas de estudiante.',
};

export class ApiError extends Error {
    // `extra`: objeto plano que se vuelca al nivel de `code`/`message` en el cuerpo del error
    // (p. ej. `holder`). Nunca pisa `code` ni `message` (ver envelope.js).
    constructor(status, code, message, { details, headers, extra } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
        this.headers = headers;
        this.extra = extra;
    }

    static badRequest(message = 'La solicitud no es válida.') {
        return new ApiError(400, 'BAD_REQUEST', message);
    }

    static invalidCode(message = 'Código inválido o vencido. Solicita uno nuevo.') {
        return new ApiError(400, 'INVALID_CODE', message);
    }

    static invalidToken(message = 'El enlace o token ya no es válido. Vuelve a solicitarlo.') {
        return new ApiError(400, 'INVALID_TOKEN', message);
    }

    static unauthenticated(message = 'Tu sesión expiró. Inicia sesión nuevamente.') {
        return new ApiError(401, 'UNAUTHENTICATED', message);
    }

    static invalidCredentials(message = 'Correo o contraseña incorrectos.') {
        return new ApiError(401, 'INVALID_CREDENTIALS', message);
    }

    static forbidden(message = 'No tienes permiso para realizar esta acción.') {
        return new ApiError(403, 'FORBIDDEN', message);
    }

    static capabilityRequired(capability, message = CAPABILITY_MESSAGES[capability] ?? 'Tu tipo de cuenta no puede realizar esta acción.') {
        return new ApiError(403, 'CAPABILITY_REQUIRED', message, { details: { capability } });
    }

    static paymentPending(message = 'Ya tienes un pago en revisión. Te avisaremos por correo cuando se active tu suscripción.') {
        return new ApiError(409, 'PAYMENT_PENDING', message);
    }

    static renewalAlreadyQueued(message = 'Ya renovaste tu plan: la renovación empieza cuando termine el periodo actual. Podrás renovar de nuevo entonces.') {
        return new ApiError(409, 'RENEWAL_ALREADY_QUEUED', message);
    }

    // `backSlug`: vista publica a la que volver (p. ej. la ficha del simulacro), para que el cliente no
    // mande al usuario a un listado ajeno.
    static subscriptionRequired(message = 'Esta función requiere una suscripción activa.', { backSlug } = {}) {
        return new ApiError(403, 'SUBSCRIPTION_REQUIRED', message, backSlug ? { details: { back_slug: backSlug } } : undefined);
    }

    static institutionRestricted(message = 'Tu plan está limitado a otra institución.') {
        return new ApiError(403, 'INSTITUTION_RESTRICTED', message);
    }

    static emailNotVerified(message = 'Tu correo aún no está verificado.') {
        return new ApiError(403, 'EMAIL_NOT_VERIFIED', message);
    }

    static accountDisabled(message = 'Tu cuenta está desactivada. Contacta a soporte.') {
        return new ApiError(403, 'ACCOUNT_DISABLED', message);
    }

    static notFound(message = 'No se encontró el recurso solicitado.') {
        return new ApiError(404, 'NOT_FOUND', message);
    }

    // Simulacros programados (contrato §8).
    static registrationClosed(message = 'La inscripción a este simulacro ya cerró.') {
        return new ApiError(403, 'REGISTRATION_CLOSED', message);
    }

    static notStarted(message = 'El simulacro todavía no ha comenzado.') {
        return new ApiError(403, 'NOT_STARTED', message);
    }

    static windowEnded(message = 'El simulacro ya terminó.') {
        return new ApiError(403, 'WINDOW_ENDED', message);
    }

    static attemptFinished(message = 'Este intento ya terminó.') {
        return new ApiError(409, 'ATTEMPT_ALREADY_FINISHED', message);
    }

    // `holder`: { client, last_seen_at, retry_after_seconds }; sale como `error.holder`.
    static attemptActiveElsewhere(holder, message = 'Tu examen está abierto en otro dispositivo.') {
        return new ApiError(409, 'ATTEMPT_ACTIVE_ELSEWHERE', message, { extra: { holder } });
    }

    // Cambio a un plan que reduciria el acceso vigente (#Libs/plan_change.js).
    static planChangeBlocked(message) {
        return new ApiError(409, 'PLAN_CHANGE_BLOCKED', message);
    }

    static conflict(message = 'La operación entra en conflicto con el estado actual.') {
        return new ApiError(409, 'CONFLICT', message);
    }

    static validation(details, message = 'Hay datos que no son válidos.') {
        return new ApiError(422, 'VALIDATION_ERROR', message, { details });
    }

    static updateRequired(minVersion) {
        return new ApiError(426, 'APP_UPDATE_REQUIRED',
            `Debes actualizar la aplicación (versión mínima ${minVersion}).`);
    }

    static tooManyRequests(retryAfterSeconds, message = 'Demasiadas solicitudes. Intenta de nuevo en unos instantes.') {
        const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds || 1));
        return new ApiError(429, 'TOO_MANY_REQUESTS', message, {
            headers: { 'Retry-After': String(retryAfter) },
        });
    }

    static internal(message = 'Ocurrió un error inesperado. Intenta nuevamente.') {
        return new ApiError(500, 'INTERNAL_ERROR', message);
    }

    static emailDeliveryFailed(message = 'No pudimos enviar el correo. Intenta reenviar el código.') {
        return new ApiError(503, 'EMAIL_DELIVERY_FAILED', message);
    }

    static serviceUnavailable(code = 'SERVICE_UNAVAILABLE', message = 'El servicio no está disponible en este momento. Intenta nuevamente.') {
        return new ApiError(503, code, message);
    }

    static maintenance(message = 'Estamos en mantenimiento. Vuelve a intentarlo más tarde.') {
        return new ApiError(503, 'MAINTENANCE', message);
    }
}

export default ApiError;
