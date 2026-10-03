import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { imageSize } from 'image-size';

// Foto de perfil. Se guarda bajo /uploads/avatars (no bajo /images, que en local
// se reescribe hacia PUBLIC_URL, ver src/config/express.js).
export const DEFAULT_AVATAR = '/assets/media/avatars/blank.png';
export const AVATAR_URL_PREFIX = '/uploads/avatars/';
export const AVATAR_DIR = 'src/public/uploads/avatars/';

const MAX_SIDE = 4000;
const MIN_SIDE = 64;
// Extension segun el formato REAL de la imagen, no segun lo que declare el cliente.
const EXTENSION_BY_TYPE = { png: 'png', jpg: 'jpg', jpeg: 'jpg' };

// Valida el buffer de una imagen subida y devuelve su extension. Lanza un Error
// con mensaje apto para el usuario si el contenido no es un PNG/JPG legitimo.
export const inspectAvatar = (buffer) => {
    let info;
    try {
        info = imageSize(buffer);
    } catch {
        throw new Error('El archivo no es una imagen válida.');
    }
    const extension = EXTENSION_BY_TYPE[info.type];
    if (!extension) throw new Error('Solo se permiten imágenes PNG o JPG.');
    if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE) {
        throw new Error(`La imagen no puede superar ${MAX_SIDE}px por lado.`);
    }
    if (info.width < MIN_SIDE || info.height < MIN_SIDE) {
        throw new Error(`La imagen debe medir al menos ${MIN_SIDE}px por lado.`);
    }
    return extension;
};

export const saveAvatar = async (userId, buffer, extension) => {
    const filename = `${userId}_${crypto.randomBytes(6).toString('hex')}.${extension}`;
    await fs.mkdir(AVATAR_DIR, { recursive: true });
    await fs.writeFile(path.join(AVATAR_DIR, filename), buffer);
    return AVATAR_URL_PREFIX + filename;
};

// Borra la foto anterior solo si es una de las subidas por usuarios; la ruta se
// resuelve por nombre de archivo para que un valor raro en BD no salga del directorio.
export const deleteAvatar = async (url) => {
    if (!url || !url.startsWith(AVATAR_URL_PREFIX)) return;
    await fs.unlink(path.join(AVATAR_DIR, path.basename(url))).catch(() => {});
};
