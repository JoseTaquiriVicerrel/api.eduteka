import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { compareVersions } from '#Libs/semver.js';

// Header X-App-Version de la app Android. Si es menor que APP_MIN_VERSION se
// responde 426 y la app muestra la pantalla de actualizar.
//
// Una peticion SIN el header (la web, curl, las pruebas) pasa: solo se bloquea a
// quien se identifica con una version vieja. Tampoco se aplica a /config ni a
// /health: la app lee /config justamente para enterarse de que debe actualizar.

const EXEMPT_PATHS = new Set(['/config', '/health']);

export default function appVersion(req, res, next) {
    if (EXEMPT_PATHS.has(req.path)) return next();

    const version = req.get('x-app-version');
    if (version && compareVersions(version, settings.app.minVersion) === -1) {
        return next(ApiError.updateRequired(settings.app.minVersion));
    }
    return next();
}
