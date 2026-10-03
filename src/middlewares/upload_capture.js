import multer from 'multer';
import { ApiError } from '#Libs/api_error.js';
import { CAPTURE_MAX_BYTES } from '#Libs/capture_storage.js';

// Comprobante de pago (multipart): un archivo, en memoria, maximo 5 MB. Una peticion JSON
// pasa de largo: multer solo actua con multipart/form-data. El contenido real se valida
// al guardarlo (#Libs/capture_storage.js).
//
// `fields` son los nombres aceptados para el archivo: el primero es el del contrato y el
// resto, alias que usa la web. El archivo queda en `req.capture` (Buffer o null).

const TEXT_FIELD_MAX_BYTES = 100 * 1024;

export const captureUpload = (fields) => {
    const [mainField] = fields;
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: CAPTURE_MAX_BYTES, files: 1, fields: 10, fieldSize: TEXT_FIELD_MAX_BYTES },
        fileFilter: (req, file, cb) => {
            if (['image/png', 'image/jpeg'].includes(file.mimetype)) return cb(null, true);
            return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'tipo'));
        },
    }).fields(fields.map((name) => ({ name, maxCount: 1 })));

    return function uploadCapture(req, res, next) {
        upload(req, res, (error) => {
            if (error) {
                if (error.code === 'LIMIT_FILE_SIZE') return next(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'El comprobante supera los 5 MB.'));
                if (error instanceof multer.MulterError) {
                    const message = error.field === 'tipo'
                        ? 'El comprobante debe ser una imagen PNG o JPG.'
                        : `Envía un solo archivo en el campo "${mainField}".`;
                    return next(ApiError.validation([{ field: mainField, message }]));
                }
                return next(ApiError.badRequest('No se pudo leer el archivo.'));
            }
            const file = fields.map((name) => req.files?.[name]?.[0]).find(Boolean);
            req.capture = file?.buffer ?? null;
            return next();
        });
    };
};

// Inscripcion a simulacros: `screenshot` (o `capture`, el nombre que usa la web).
export default captureUpload(['screenshot', 'capture']);
