import pino from 'pino';
import { settings } from '#Config/settings.js';

// Un solo logger para toda la API. Las peticiones usan `req.log` (pino-http), que
// ya lleva el `request_id`. Nada de lo que aparezca aqui debe ser un secreto:
// las cabeceras sensibles se ocultan y los cuerpos de las peticiones nunca se
// registran (contienen contraseñas y codigos).
export const logger = pino({
    level: settings.logLevel,
    redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[oculto]',
    },
    ...(settings.prettyLogs ? { transport: { target: 'pino-pretty' } } : {}),
});

export default logger;
