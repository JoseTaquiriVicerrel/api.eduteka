// HTML del PDF de una lista de preguntas, listo para imprimir en edk-docs.
//
// Autocontenido: CSS en linea, formulas como SVG incrustado (mismo mathStore que `?math=svg`) e
// imagenes incrustadas desde la carpeta publica del monolito. No pide nada a la red: la plantilla
// del monolito (preguntas/file_pdf.hbs) cargaba Metronic, MathJax y fuentes de CDN, y sin salida a
// Internet el PDF salia con las formulas en LaTeX.
//
// Mismo diseño que la del monolito: dos columnas con regla punteada, area encima de cada pregunta,
// alternativas debajo. La cabecera, el pie y la marca de agua los pone edk-docs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { settings } from '#Config/settings.js';
import { mathFilePath, mathStore } from '#Libs/math_store.js';
import { MATH_ROUTE, replaceMath } from '#Libs/math_svg.js';
import { absoluteUrl } from '#Libs/urls.js';

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

const replaceAsync = async (text, regex, resolve) => {
    const matches = [...text.matchAll(regex)];
    const replacements = await Promise.all(matches.map((match) => resolve(...match)));
    let out = '';
    let last = 0;
    matches.forEach((match, i) => {
        out += text.slice(last, match.index) + replacements[i];
        last = match.index + match[0].length;
    });
    return out + text.slice(last);
};

/**
 * Cambia cada <img src="/..."> por su data URI:
 *   - formulas (`/api/v1/media/math/<hash>.svg`): el SVG que dejo el mathStore en disco;
 *   - imagenes de preguntas (`/images/...`): el archivo de la carpeta publica del monolito.
 * Lo que no esta en disco se deja con la URL absoluta de la web (Chromium la pide por la red).
 * Nunca sale de la carpeta publica (ni con `..` codificado).
 */
export const inlineImages = (html, { publicDir = settings.docs.publicDir, mathDir } = {}) => {
    const root = path.resolve(publicDir);
    const cache = new Map();
    const read = (file) => {
        if (!cache.has(file)) cache.set(file, fs.readFile(file).then((buf) => buf.toString('base64')));
        return cache.get(file);
    };

    return replaceAsync(html, /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(\/(?!\/)[^"']+)\2/gi, async (match, head, quote, src) => {
        const clean = src.split(/[?#]/)[0];
        try {
            if (clean.startsWith(MATH_ROUTE)) {
                const file = mathFilePath(clean.slice(MATH_ROUTE.length), ...(mathDir ? [mathDir] : []));
                if (file) return `${head}${quote}data:image/svg+xml;base64,${await read(file)}${quote}`;
            } else {
                const file = path.resolve(root, `.${decodeURIComponent(clean)}`);
                const mime = IMG_MIME[path.extname(file).toLowerCase()];
                if (mime && file.startsWith(root + path.sep)) return `${head}${quote}data:${mime};base64,${await read(file)}${quote}`;
            }
        } catch {
            // No esta en disco: se cae a la URL absoluta.
        }
        return `${head}${quote}${escapeHtml(absoluteUrl(src) ?? src)}${quote}`;
    });
};

const STYLE = `
    @page { size: A4; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #181C32; background: #fff; }
    h1 { font-size: 15pt; margin: 0 0 4px; }
    .description { color: #5E6278; margin: 0 0 10px; font-size: 10pt; }
    .questions { column-count: 2; column-gap: 18px; column-rule: 1px dotted rgba(0, 0, 0, .25); }
    .question { break-inside: avoid; margin: 0 0 12px; }
    .meta { color: #00BF63; font-size: 9pt; font-weight: bold; margin-bottom: 2px; }
    .number { font-weight: bold; flex: none; }
    /* El numero va en la misma linea que el enunciado aunque este empiece con un <p>. */
    .statement { display: flex; gap: 4px; align-items: baseline; }
    .statement > .body { min-width: 0; }
    .statement p { margin: 0 0 4px; }
    .statement img, .option img { max-width: 100%; height: auto; }
    img.math { vertical-align: middle; max-width: 100%; }
    .options { margin-top: 4px; }
    .option { display: flex; gap: 4px; margin: 0 0 2px; }
    .option p { margin: 0; }
    .key { break-before: page; }
    .key h2 { font-size: 13pt; margin: 0 0 8px; }
    .key-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px 12px; font-size: 10pt; }
`;

/**
 * @param {{ title: string, description?: string, includeAnswers?: boolean,
 *           questions: Array<{ area?: string, question: string, options: Array<{ key: string, text: string }>, correct?: string }> }} list
 * @param {{ convert?: Function, publicDir?: string, mathDir?: string }} [options] `convert` = getAsset del mathStore (inyectable en pruebas)
 */
export const buildListHtml = async (list, { convert, publicDir, mathDir } = {}) => {
    const toSvg = convert ?? ((args) => mathStore().getAsset(args));
    // El HTML de las preguntas lo escriben editores, pero Chromium ejecutaria cualquier script al
    // imprimir: se quitan <script>, manejadores on* y URLs javascript: antes de armar el documento.
    const clean = (html) => String(html ?? '')
        .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<script\b[^>]*>/gi, '')
        .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2');
    const withMath = async (html) => (await replaceMath(clean(html), toSvg)).html;

    const items = await Promise.all(list.questions.map(async (item, index) => {
        const options = await Promise.all(item.options.map(async (option) => (
            `<div class="option"><strong>${escapeHtml(option.key)})</strong><div>${await withMath(option.text)}</div></div>`
        )));
        return `<div class="question">
            ${item.area ? `<div class="meta">${escapeHtml(item.area)}</div>` : ''}
            <div class="statement"><span class="number">${index + 1}.</span><div class="body">${await withMath(item.question)}</div></div>
            <div class="options">${options.join('')}</div>
        </div>`;
    }));

    const key = list.includeAnswers
        ? `<section class="key"><h2>Clave de respuestas</h2><div class="key-grid">${list.questions
            .map((item, index) => `<div>${index + 1}. <strong>${escapeHtml(item.correct ?? '-')}</strong></div>`).join('')}</div></section>`
        : '';

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(list.title)}</title><style>${STYLE}</style></head>
<body>
    <h1>${escapeHtml(list.title)}</h1>
    ${list.description ? `<p class="description">${escapeHtml(list.description)}</p>` : ''}
    <div class="questions">${items.join('')}</div>
    ${key}
</body></html>`;

    return inlineImages(html, { publicDir, mathDir });
};
