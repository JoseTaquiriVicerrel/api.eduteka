import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { imageSize } from 'image-size';
import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';

// Comprobantes de pago (simulacros, pedidos de la tienda y suscripciones). A diferencia
// del avatar, el archivo se guarda TAL CUAL (el administrador necesita ver el original),
// pero solo despues de comprobar por su contenido que es un PNG o JPG real, y con un
// nombre generado.
//
// La ruta que se escribe en el documento sigue la convencion del monolito, que es quien
// muestra el comprobante en su panel:
//  - simulacros:    /protected/pay_capture/<archivo>          (carpeta PAY_CAPTURE_DIR)
//  - pedidos:       /storage/payment/store/<archivo>          (FILES_ROOT_DIR/storage/payment/store)
//  - suscripciones: /storage/payment/suscriptions/<archivo>   (FILES_ROOT_DIR/storage/payment/suscriptions)
// El monolito sirve /storage/payment solo a administradores; con FILES_ROOT_DIR apuntando
// a su carpeta `src`, los comprobantes de la API caen donde los busca.

export const CAPTURE_MAX_BYTES = 5 * 1024 * 1024;
export const CAPTURE_URL_PREFIX = '/protected/pay_capture/';

const TARGETS = Object.freeze({
    simulacrum: { prefix: CAPTURE_URL_PREFIX, dir: () => settings.payCaptureDir },
    order: { prefix: '/storage/payment/store/', dir: () => path.join(settings.filesRootDir, 'storage', 'payment', 'store') },
    subscription: { prefix: '/storage/payment/suscriptions/', dir: () => path.join(settings.filesRootDir, 'storage', 'payment', 'suscriptions') },
});

const EXTENSIONS = { png: 'png', jpg: 'jpg' };

/**
 * Guarda el comprobante y devuelve la ruta publica (relativa al monolito) que se escribe
 * en el documento. `field` es el campo que se nombra en el error de validacion.
 */
export const saveCapture = async (buffer, { target = 'simulacrum', field = 'screenshot' } = {}) => {
    const { prefix, dir } = TARGETS[target];
    let type;
    try {
        type = imageSize(buffer).type;
    } catch {
        throw ApiError.validation([{ field, message: 'El comprobante no es una imagen válida.' }]);
    }
    const extension = EXTENSIONS[type];
    if (!extension) throw ApiError.validation([{ field, message: 'El comprobante debe ser una imagen PNG o JPG.' }]);

    const filename = `${randomBytes(9).toString('hex')}.${extension}`;
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(path.join(dir(), filename), buffer);
    return `${prefix}${filename}`;
};

/** Borra un comprobante guardado por la API (si el registro fallo despues de subirlo). */
export const deleteCapture = async (url) => {
    if (typeof url !== 'string') return;
    const target = Object.values(TARGETS).find(({ prefix }) => url.startsWith(prefix));
    if (!target) return;
    const name = path.basename(url);
    if (/^[a-f0-9]+\.(png|jpg)$/.test(name)) await fs.unlink(path.join(target.dir(), name)).catch(() => {});
};
