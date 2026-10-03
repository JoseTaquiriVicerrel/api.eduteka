import fs from 'node:fs/promises';
import path from 'node:path';
import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';

// Acceso a los archivos descargables. Las rutas (`files[].path`) vienen de la base y
// son relativas a FILES_ROOT_DIR. NUNCA se sirven con express.static: cada descarga
// pasa por un controlador que comprueba el permiso antes de llegar aqui.

/**
 * Resuelve una ruta guardada a un archivo REAL dentro de la raiz, o null.
 *
 * Se compara contra la ruta real (realpath) de la raiz y del archivo, de modo que ni un
 * `../` en el dato ni un enlace simbolico pueden sacar la lectura de la carpeta.
 */
export const resolveStoredFile = async (storedPath) => {
    if (typeof storedPath !== 'string' || storedPath.trim() === '') return null;

    try {
        const root = await fs.realpath(settings.filesRootDir);
        const candidate = path.resolve(root, `.${path.sep}${storedPath.replace(/^[/\\]+/, '')}`);
        const real = await fs.realpath(candidate);

        if (real !== root && !real.startsWith(root + path.sep)) return null;

        const stat = await fs.stat(real);
        if (!stat.isFile()) return null;

        return { absolute: real, size: stat.size, extension: path.extname(real).replace('.', '').toLowerCase() };
    } catch {
        // No existe, sin permiso o ruta invalida: para el cliente es lo mismo.
        return null;
    }
};

/**
 * Envia el archivo como adjunto. `res.download` usa `send`: soporta `Range`
 * (descargas reanudables), `Content-Length`, `Content-Disposition: attachment` con el
 * nombre codificado y `Accept-Ranges`. El `Cache-Control: no-store` global se conserva.
 */
export const sendFile = (res, absolutePath, downloadName) =>
    new Promise((resolve, reject) => {
        res.download(absolutePath, downloadName, { dotfiles: 'deny' }, (error) => {
            if (!error) return resolve();
            // Si ya empezo a enviarse, no hay forma de cambiar la respuesta.
            if (res.headersSent) return resolve();
            return reject(ApiError.notFound('El archivo ya no está disponible.'));
        });
    });
