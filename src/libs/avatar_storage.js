import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { imageSize } from 'image-size';
import Jimp from 'jimp-compact';
import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';

// Fotos de perfil. Se guardan en STORAGE_DIR/avatars (fuera de cualquier raiz
// estatica) y las sirve GET /api/v1/media/avatars/:file.
//
// El archivo subido NUNCA se guarda tal cual: se decodifica y se vuelve a codificar
// como JPEG cuadrado de 256 px. Eso elimina los metadatos (EXIF con ubicacion) y
// cualquier contenido ajeno a la imagen (polyglots), y deja un tamaño fijo y pequeño.

export const AVATAR_ROUTE = '/api/v1/media/avatars/';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const AVATAR_DIR = path.join(settings.storageDir, 'avatars');
const SIZE = 256;
// Una imagen muy comprimida pesa poco y ocupa mucha memoria al decodificarse.
const MAX_SIDE = 3000;
const MIN_SIDE = 64;
const FILE_PATTERN = /^[A-Za-z0-9_-]+\.jpg$/;

const invalid = (message) => ApiError.validation([{ field: 'avatar', message }]);

/** Valida y normaliza la imagen subida. Devuelve un JPEG de 256x256. */
export const processAvatar = async (buffer) => {
    let info;
    try {
        info = imageSize(buffer);
    } catch {
        throw invalid('El archivo no es una imagen válida.');
    }
    // Se decide por el contenido real, no por el tipo que declare el cliente.
    if (!['png', 'jpg'].includes(info.type)) throw invalid('Solo se permiten imágenes PNG o JPG.');
    if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE) {
        throw invalid(`La imagen no puede superar ${MAX_SIDE}px por lado.`);
    }
    if (info.width < MIN_SIDE || info.height < MIN_SIDE) throw invalid(`La imagen debe medir al menos ${MIN_SIDE}px por lado.`);

    try {
        const image = (await Jimp.read(buffer)).cover(SIZE, SIZE);
        // El PNG con transparencia se aplana sobre blanco (JPEG no tiene alfa).
        const flat = new Jimp(SIZE, SIZE, 0xffffffff).composite(image, 0, 0).quality(85);
        return await flat.getBufferAsync(Jimp.MIME_JPEG);
    } catch {
        throw invalid('No se pudo procesar la imagen.');
    }
};

/** Guarda el avatar y devuelve la URL que se escribe en `User.avatar`. */
export const saveAvatar = async (userId, jpegBuffer) => {
    const filename = `${String(userId).replace(/[^A-Za-z0-9_-]/g, '')}_${randomBytes(6).toString('hex')}.jpg`;
    await fs.mkdir(AVATAR_DIR, { recursive: true });
    await fs.writeFile(path.join(AVATAR_DIR, filename), jpegBuffer);
    // Con PUBLIC_API_URL la URL es absoluta (sirve tambien a la web); sin ella, relativa.
    return `${settings.app.apiUrl ?? ''}${AVATAR_ROUTE}${filename}`;
};

/** Ruta en disco de un avatar de la API, o null si el nombre no es valido. */
export const avatarPath = (filename) => (FILE_PATTERN.test(filename) ? path.join(AVATAR_DIR, filename) : null);

/** Borra el archivo anterior, solo si es uno subido por la API (los del monolito no son nuestros). */
export const deleteAvatar = async (url) => {
    if (typeof url !== 'string' || !url.includes(AVATAR_ROUTE)) return;
    const target = avatarPath(path.basename(url));
    if (target) await fs.unlink(target).catch(() => {});
};
