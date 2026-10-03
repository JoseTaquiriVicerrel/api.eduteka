import { settings } from '#Config/settings.js';

// Absolutizacion de rutas para clientes nativos.
//
// La web sirve todo desde su propio origen, asi que el HTML de las preguntas
// guarda rutas relativas (`<img src="/images/questions/...">`). Un cliente movil
// no tiene origen contra el que resolverlas: sin esta reescritura no se vería
// ninguna imagen. La base es PUBLIC_WEB_URL (settings.app.webUrl), ya con esquema.

/** Convierte una ruta relativa en absoluta. Deja intactas las absolutas y las `data:`. */
export const absoluteUrl = (pathOrUrl) => {
    if (!pathOrUrl || typeof pathOrUrl !== 'string') return pathOrUrl ?? null;

    const value = pathOrUrl.trim();
    if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:')) return value;
    if (!settings.app.webUrl) return value;

    return `${settings.app.webUrl}/${value.replace(/^\/+/, '')}`;
};

// Valores de src/href entrecomillados que empiezan por "/" (no toca data:, http:
// ni anclas internas).
const RELATIVE_ATTR = /(\ssrc|\shref)=("|')(\/[^"']*)\2/gi;

/** Reescribe a absoluto todo src/href relativo dentro de un fragmento de HTML. */
export const absolutizeHtml = (html) => {
    if (!html || typeof html !== 'string') return html ?? null;
    return html.replace(RELATIVE_ATTR, (_match, attr, quote, path) => `${attr}=${quote}${absoluteUrl(path)}${quote}`);
};
