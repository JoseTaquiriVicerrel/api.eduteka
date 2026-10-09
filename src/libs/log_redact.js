import pino from 'pino';

// Parametros de la URL que son credenciales (enlace de descarga firmado: /descargas/archivo?token=).
// pino-http registra la URL de cada peticion; sin esto el token quedaria en los logs.
const SENSITIVE_PARAMS = ['token'];

const PATTERN = new RegExp(`([?&](?:${SENSITIVE_PARAMS.join('|')})=)[^&#]*`, 'gi');

/** La URL con el valor de los parametros sensibles oculto. */
export const redactUrl = (url) => (typeof url === 'string' ? url.replace(PATTERN, '$1[oculto]') : url);

/** Serializador `req` de pino-http: el estandar, con la URL (y la query, si viene) sin credenciales. */
export const serializeRequest = (req) => {
    const serialized = pino.stdSerializers.req(req);
    serialized.url = redactUrl(serialized.url);
    if (serialized.query && typeof serialized.query === 'object') {
        serialized.query = Object.fromEntries(Object.entries(serialized.query)
            .map(([key, value]) => [key, SENSITIVE_PARAMS.includes(key.toLowerCase()) ? '[oculto]' : value]));
    }
    return serialized;
};
