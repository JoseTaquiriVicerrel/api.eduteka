import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';

// Modo mantenimiento (APP_MAINTENANCE=true): toda la API responde 503 excepto
// /config, que es como la app se entera, y /health, que usan los monitores.
const EXEMPT_PATHS = new Set(['/config', '/health']);

export default function maintenance(req, res, next) {
    if (settings.app.maintenance && !EXEMPT_PATHS.has(req.path)) {
        return next(ApiError.maintenance());
    }
    return next();
}
