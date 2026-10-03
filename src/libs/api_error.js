// Error de dominio de la API. Lo lanzan servicios y middlewares; el manejador de
// errores (#Middlewares/error_handler.js) lo convierte en el envelope de error.
//
// `code` es parte del contrato con los clientes: en ingles, estable, y no se
// renombra. `message` es texto para mostrar y puede cambiar.

export class ApiError extends Error {
    constructor(status, code, message, { details, headers } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
        this.headers = headers;
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

    static subscriptionRequired(message = 'Esta función requiere una suscripción activa.') {
        return new ApiError(403, 'SUBSCRIPTION_REQUIRED', message);
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

    static maintenance(message = 'Estamos en mantenimiento. Vuelve a intentarlo más tarde.') {
        return new ApiError(503, 'MAINTENANCE', message);
    }
}

export default ApiError;
