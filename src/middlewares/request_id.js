import { randomUUID } from 'node:crypto';

// X-Request-Id entrante (si es razonable) o uno generado. Se devuelve en la
// cabecera y en el cuerpo de los errores para poder cruzar el reporte de un
// usuario con el log del servidor.
const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

export default function requestId(req, res, next) {
    const inbound = req.get('x-request-id');
    req.id = inbound && VALID_ID.test(inbound) ? inbound : randomUUID().replace(/-/g, '').slice(0, 12);
    res.setHeader('X-Request-Id', req.id);
    next();
}
