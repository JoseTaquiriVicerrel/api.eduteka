import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ApiError } from '#Libs/api_error.js';

// Validacion de body, query y params con esquemas TypeBox (que ya son JSON
// Schema). Se compila una sola vez por esquema.
//
//   router.post('/login', validate(LoginBody), handler)
//   router.get('/x',      validate(ListQuery, 'query'), handler)
//
// El resultado validado (con los valores por defecto aplicados y, en `query`,
// los numeros ya convertidos) reemplaza al original en `req`.

const options = { allErrors: true, strict: true, useDefaults: true };

// `query` llega siempre como texto: se convierte a numero/booleano. `body` no se
// convierte nunca: un "5" donde se espera un numero es un error, no un 5.
const ajvStrict = addFormats(new Ajv(options), ['email', 'uuid', 'date-time', 'uri']);
const ajvCoerce = addFormats(new Ajv({ ...options, coerceTypes: 'array' }), ['email', 'uuid', 'date-time', 'uri']);

const cache = new WeakMap();

const compile = (schema, source) => {
    const ajv = source === 'query' ? ajvCoerce : ajvStrict;
    let bySource = cache.get(schema);
    if (!bySource) {
        bySource = {};
        cache.set(schema, bySource);
    }
    bySource[source] ??= ajv.compile(schema);
    return bySource[source];
};

const FIELD_MESSAGES = {
    required: () => 'Este campo es obligatorio.',
    type: (e) => `Debe ser de tipo ${e.params.type}.`,
    minLength: (e) => `Debe tener al menos ${e.params.limit} caracteres.`,
    maxLength: (e) => `Debe tener como máximo ${e.params.limit} caracteres.`,
    minimum: (e) => `Debe ser mayor o igual a ${e.params.limit}.`,
    maximum: (e) => `Debe ser menor o igual a ${e.params.limit}.`,
    minItems: (e) => `Debe tener al menos ${e.params.limit} elementos.`,
    maxItems: (e) => `Debe tener como máximo ${e.params.limit} elementos.`,
    enum: (e) => `Debe ser uno de: ${e.params.allowedValues.join(', ')}.`,
    pattern: () => 'El formato no es válido.',
    format: (e) => (e.params.format === 'email' ? 'Debe ser un correo válido.' : 'El formato no es válido.'),
    additionalProperties: () => 'Campo no permitido.',
};

const toDetails = (errors) => {
    const seen = new Set();
    const details = [];

    for (const error of errors) {
        const base = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
        let field = base;
        if (error.keyword === 'required') field = [base, error.params.missingProperty].filter(Boolean).join('.');
        if (error.keyword === 'additionalProperties') field = [base, error.params.additionalProperty].filter(Boolean).join('.');

        const message = (FIELD_MESSAGES[error.keyword] ?? (() => 'Valor no válido.'))(error);
        const key = `${field}|${message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        details.push({ field: field || '(cuerpo)', message });
    }
    return details;
};

export default function validate(schema, source = 'body') {
    if (!['body', 'query', 'params'].includes(source)) {
        throw new Error(`validate: origen desconocido "${source}"`);
    }
    const check = compile(schema, source);

    return function validateMiddleware(req, res, next) {
        // Ajv modifica el objeto al aplicar defaults/conversiones: se trabaja sobre una copia.
        const data = structuredClone(req[source] ?? {});
        if (!check(data)) return next(ApiError.validation(toDetails(check.errors)));

        if (source === 'query') {
            // En Express 4 `req.query` se puede reasignar; en 5 es un getter.
            Object.defineProperty(req, 'query', { value: data, writable: true, configurable: true });
        } else {
            req[source] = data;
        }
        return next();
    };
}
