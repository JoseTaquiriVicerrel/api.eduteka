
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { convertSlug } from './functions.js';
import { normalizeText } from './text_utils.js';

export const generateHybridSlug = (area, uid) => {
    const cleanArea = normalizeText(area).replace(/\s+/g, '-');
    return `${cleanArea}/${uid}`;
};

export const generateUid = () => nanoid(6);

/**
 * Slug de un bloque de lectura: `lectura-unmsm-97d6991f`.
 *
 * El sufijo es aleatorio, no un hash del texto: dos lecturas distintas del mismo
 * examen pueden empezar igual ("Lea atentamente el siguiente texto...") y un
 * slug derivado del contenido las colisionaria. Es el mismo formato que ya
 * tienen los 185 bloques con slug, para no partir la coleccion en dos.
 *
 * Sin institucion el slug queda como `lectura-<hash>`: sigue siendo unico y
 * resoluble por /lecturas/:slug, solo pierde legibilidad.
 */
export const generateBlockSlug = (abrev) => {
    const prefix = convertSlug(abrev ?? '');
    const hash = crypto.randomBytes(4).toString('hex');
    return prefix ? `lectura-${prefix}-${hash}` : `lectura-${hash}`;
};
