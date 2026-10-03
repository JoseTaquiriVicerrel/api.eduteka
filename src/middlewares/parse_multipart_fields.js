import { ApiError } from '#Libs/api_error.js';

// En multipart/form-data todo campo de texto llega como string. Este middleware va
// entre multer y `validate` y convierte los campos que el contrato declara como JSON o
// como numero, para que el esquema TypeBox sea el mismo que en una peticion JSON.
//
//   parseMultipartFields({ json: ['items'], number: ['expected_total'] })
//
// Una peticion que no es multipart pasa sin cambios. Un numero que no se puede leer se
// deja como texto: lo rechaza el esquema con su mensaje habitual.

export default function parseMultipartFields({ json = [], number = [] } = {}) {
    return function parseMultipartFieldsMiddleware(req, res, next) {
        if (!req.is('multipart/form-data') || !req.body) return next();

        for (const field of json) {
            const raw = req.body[field];
            if (typeof raw !== 'string') continue;
            try {
                req.body[field] = JSON.parse(raw);
            } catch {
                return next(ApiError.validation([{ field, message: 'Debe ser un JSON válido.' }]));
            }
        }

        for (const field of number) {
            const raw = req.body[field];
            if (typeof raw !== 'string' || raw.trim() === '') continue;
            const value = Number(raw);
            if (Number.isFinite(value)) req.body[field] = value;
        }

        return next();
    };
}
