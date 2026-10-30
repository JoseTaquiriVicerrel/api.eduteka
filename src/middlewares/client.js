import { settings } from '#Config/settings.js';
import { safeEqual } from '#Libs/tokens.js';

/**
 * Quien llama: 'web' (servidor de Next con el secreto) o 'app' (todo lo demas).
 * Nunca corta la peticion: un secreto invalido es 'app', sin error, para no
 * servir de oraculo. Ver docs/spec-api-eduteka-1-cliente-web.md.
 */
export default function identifyClient(req, res, next) {
    const secret = settings.webClient.secret;
    const declared = String(req.get('x-edk-client') ?? '').trim().toLowerCase();
    const presented = req.get('x-edk-client-secret');

    req.client = secret && declared === 'web' && safeEqual(presented, secret) ? 'web' : 'app';

    // El secreto no debe seguir viajando por la peticion (logs, errores, handlers).
    delete req.headers['x-edk-client-secret'];
    return next();
}
