import { ApiError } from '#Libs/api_error.js';
import { errorBody } from '#Libs/envelope.js';

// Ultimo middleware. Convierte cualquier error en el envelope de error y decide
// cuanto se cuenta: un ApiError es una decision del servidor y se muestra tal
// cual; cualquier otra cosa es un bug y el cliente solo ve un 500 generico (el
// detalle va al log con el request_id).

export function notFound(req, res, next) {
    next(ApiError.notFound('La ruta solicitada no existe.'));
}

export function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    let apiError = err;

    if (!(err instanceof ApiError)) {
        // Errores de body-parser: JSON mal formado o cuerpo demasiado grande.
        if (err?.type === 'entity.parse.failed') {
            apiError = ApiError.badRequest('El cuerpo de la petición no es un JSON válido.');
        } else if (err?.type === 'entity.too.large') {
            apiError = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo de la petición es demasiado grande.');
        } else if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
            apiError = ApiError.badRequest('La codificación de la petición no está soportada.');
        } else {
            (req.log ?? console).error({ err }, 'Error no controlado');
            apiError = ApiError.internal();
        }
    }

    if (apiError.headers) res.set(apiError.headers);

    return res.status(apiError.status).json(errorBody(req, apiError));
}
