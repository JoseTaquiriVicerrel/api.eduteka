import multer from 'multer';
import { ApiError } from '#Libs/api_error.js';
import { AVATAR_MAX_BYTES } from '#Libs/avatar_storage.js';

// Subida de la foto de perfil: multipart con UN archivo en el campo `avatar`, en
// memoria (maximo 2 MB), sin escribir nada en disco hasta validarlo.
// Multer rechaza por tamaño o tipo con un Error propio: sin este envoltorio
// llegaria al manejador global como un 500.

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 2 },
    fileFilter: (req, file, cb) => {
        if (['image/png', 'image/jpeg'].includes(file.mimetype)) return cb(null, true);
        return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'tipo'));
    },
}).single('avatar');

export default function uploadAvatar(req, res, next) {
    upload(req, res, (error) => {
        if (error) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                return next(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'La imagen supera los 2 MB.'));
            }
            if (error instanceof multer.MulterError) {
                const message = error.field === 'tipo'
                    ? 'Solo se permiten imágenes PNG o JPG.'
                    : 'Envía una sola imagen en el campo "avatar".';
                return next(ApiError.validation([{ field: 'avatar', message }]));
            }
            return next(ApiError.badRequest('No se pudo leer el archivo.'));
        }
        if (!req.file) return next(ApiError.validation([{ field: 'avatar', message: 'Selecciona una imagen.' }]));
        return next();
    });
}
