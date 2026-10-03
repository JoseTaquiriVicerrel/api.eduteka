import { createHash } from 'node:crypto';

// Formulas LaTeX del HTML de las preguntas -> <img> que apunta a un SVG.
//
// Este modulo es PURO: no toca disco, red ni MathJax. Extrae las formulas, decide
// si van en bloque o en linea, prepara el TeX y sustituye cada una por la <img>
// que devuelva el conversor inyectado. La generacion del SVG y su cache viven en
// otro modulo (docs/api-latex-svg-plan.md, fases 2 y 3).

/** Se sube si cambia la plantilla de post-proceso o de la <img>; invalida todos los hashes. */
export const MATH_TEMPLATE_VERSION = '1';
export const MATH_ROUTE = '/api/v1/media/math/';
/** TeX mas largo que esto se deja tal cual (contenido roto o malicioso). */
export const MAX_TEX_LENGTH = 4096;

// Delimitadores: [apertura, cierre, bloque por defecto]. `\(` siempre va en linea.
const DELIMITERS = [
    { open: '\\[', close: '\\]', display: true },
    { open: '$$', close: '$$', display: true },
    { open: '\\(', close: '\\)', display: false },
];

// Contenido donde un delimitador es texto literal, no una formula.
const PROTECTED_ELEMENT = /<(script|style|code|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAG = /<[^>]*>/g;

// Etiquetas que cortan la "linea" visible (para decidir bloque o en linea).
const LINE_BREAK_TAG = /<\/?(?:br|p|div|li|ul|ol|tr|td|th|table|h[1-6]|blockquote)\b[^>]*>/gi;

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

/** Decodifica las entidades que el banco deja dentro del TeX. `&nbsp;` pasa a espacio normal. */
export const decodeEntities = (text) => text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
    return code === 0xa0 ? ' ' : String.fromCodePoint(code);
});

// Letras con tilde dentro de \text{}: MathJax las dibuja como <text font-family="serif">
// (dependen de la fuente del dispositivo). Con el acento de TeX salen como trazados.
const ACCENTS = {
    á: "\\'a", é: "\\'e", í: "\\'{\\i}", ó: "\\'o", ú: "\\'u",
    Á: "\\'A", É: "\\'E", Í: "\\'I", Ó: "\\'O", Ú: "\\'U",
    ñ: '\\~n', Ñ: '\\~N', ü: '\\"u', Ü: '\\"U',
};
const ACCENT_CHARS = /[áéíóúÁÉÍÓÚñÑüÜ]/g;
const TEXT_COMMAND = /\\(?:text|mbox|textrm|textit|textbf|mathrm)\s*\{/g;

/** Indice del `}` que cierra la llave abierta justo antes de `from`, o -1. */
const closingBrace = (tex, from) => {
    let depth = 1;
    for (let i = from; i < tex.length; i += 1) {
        const char = tex[i];
        if (char === '\\') { i += 1; continue; }
        if (char === '{') depth += 1;
        else if (char === '}' && (depth -= 1) === 0) return i;
    }
    return -1;
};

/** Sustituye las tildes por su acento TeX, solo dentro de \text{...} (en modo matematico `\'` es otra cosa). */
export const normalizeAccents = (tex) => {
    if (!ACCENT_CHARS.test(tex)) return tex;
    ACCENT_CHARS.lastIndex = 0;
    let result = '';
    let cursor = 0;
    TEXT_COMMAND.lastIndex = 0;
    let match;
    while ((match = TEXT_COMMAND.exec(tex)) !== null) {
        const start = match.index + match[0].length;
        if (start < cursor) continue;
        const end = closingBrace(tex, start);
        if (end < 0) break;
        result += tex.slice(cursor, start) + tex.slice(start, end).replace(ACCENT_CHARS, (char) => ACCENTS[char]);
        cursor = end;
        TEXT_COMMAND.lastIndex = end;
    }
    return result + tex.slice(cursor);
};

/** TeX limpio a partir del contenido crudo de un delimitador: sin etiquetas, sin entidades, con tildes normalizadas. */
export const texFromHtml = (raw) => {
    const withoutTags = raw.replace(/<br\s*\/?>/gi, ' ').replace(TAG, '');
    return normalizeAccents(decodeEntities(withoutTags)).trim();
};

const protectedRanges = (html) => {
    const ranges = [];
    for (const match of html.matchAll(PROTECTED_ELEMENT)) ranges.push([match.index, match.index + match[0].length]);
    return ranges;
};

const inRanges = (ranges, index) => ranges.some(([from, to]) => index >= from && index < to);

/**
 * Busca las formulas del HTML, en orden. Cada una: { start, end, raw, tex, delimiter, display }.
 * Se ignoran las que estan dentro de <script>, <style>, <code> y <pre>, las que abren
 * dentro de una etiqueta (p. ej. en un atributo) y las vacias o de mas de MAX_TEX_LENGTH.
 */
export const extractFormulas = (html) => {
    if (typeof html !== 'string' || html.length === 0) return [];

    const ranges = protectedRanges(html);
    // Una etiqueta no puede abrir una formula: `<img alt="\(x\)">` es atributo, no contenido.
    const tags = [...html.matchAll(TAG)].map((tag) => [tag.index, tag.index + tag[0].length]);
    const formulas = [];
    let cursor = 0;

    while (cursor < html.length) {
        let best = null;
        for (const delimiter of DELIMITERS) {
            let from = cursor;
            let index;
            while ((index = html.indexOf(delimiter.open, from)) !== -1) {
                const escaped = index > 0 && html[index - 1] === '\\' && delimiter.open !== '$$';
                if (!escaped && !inRanges(ranges, index) && !inRanges(tags, index)) break;
                from = index + 1;
            }
            if (index !== -1 && (!best || index < best.index)) best = { index, delimiter };
        }
        if (!best) break;

        const { index, delimiter } = best;
        const innerStart = index + delimiter.open.length;
        const closeIndex = html.indexOf(delimiter.close, innerStart);
        if (closeIndex === -1) { cursor = innerStart; continue; }

        const end = closeIndex + delimiter.close.length;
        const raw = html.slice(innerStart, closeIndex);
        const tex = texFromHtml(raw);
        if (tex && tex.length <= MAX_TEX_LENGTH) {
            formulas.push({ start: index, end, raw: html.slice(index, end), tex, delimiter: delimiter.open, display: delimiter.display });
        }
        cursor = end;
    }
    return formulas;
};

const hasContent = (fragment) => {
    // Otra formula o una <img> cuentan como contenido; el resto de etiquetas no.
    const visible = fragment.replace(/<img\b[^>]*>/gi, '\u0000').replace(TAG, '').replace(/&nbsp;|\s/g, '');
    return visible.length > 0;
};

/**
 * Bloque o en linea. Una formula de bloque (`\[ \]`, `$$ $$`) que comparte linea con texto,
 * una <img> u otra formula se dibuja EN LINEA con \displaystyle; sola en su parrafo (o tras
 * un <br>) va en bloque. Es la misma regla que aplica la app (HtmlBlocks.inlineMixedDisplayMath).
 * Devuelve 'block' | 'inline' | 'inline-display'.
 */
export const classifyFormula = (html, formula) => {
    if (!formula.display) return 'inline';

    const lineStart = Math.max(0, ...[...html.slice(0, formula.start).matchAll(LINE_BREAK_TAG)].map((m) => m.index + m[0].length));
    const next = html.slice(formula.end).search(LINE_BREAK_TAG);
    const lineEnd = next === -1 ? html.length : formula.end + next;

    const before = html.slice(lineStart, formula.start);
    const after = html.slice(formula.end, lineEnd);
    return hasContent(before) || hasContent(after) ? 'inline-display' : 'block';
};

/** TeX que se manda al conversor: en linea con \displaystyle conserva fracciones y sumatorios grandes. */
export const texForMode = (tex, mode) => (mode === 'inline-display' ? `\\displaystyle ${tex}` : tex);

/** Nombre estable del SVG: mismo TeX + modo + version -> mismo archivo. 32 hex. */
export const mathHash = ({ tex, mode, version = '' }) => createHash('sha1')
    .update(JSON.stringify({ tex, mode, v: `${MATH_TEMPLATE_VERSION}:${version}` }))
    .digest('hex')
    .slice(0, 32);

const escapeAttr = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** <img> que sustituye a la formula. `alt` y `data-tex` conservan el LaTeX (accesibilidad y plan B). */
export const buildMathImg = ({ hash, tex, mode, w, h, valign }, { baseUrl = '' } = {}) => {
    const attrs = [
        'class="math"',
        `src="${escapeAttr(`${baseUrl}${MATH_ROUTE}${hash}.svg`)}"`,
        `alt="${escapeAttr(tex)}"`,
        `data-tex="${escapeAttr(tex)}"`,
        `data-display="${mode === 'block'}"`,
        `data-w="${escapeAttr(w)}"`,
        `data-h="${escapeAttr(h)}"`,
        `data-valign="${escapeAttr(valign)}"`,
    ];
    return `<img ${attrs.join(' ')}>`;
};

/**
 * Sustituye cada formula del HTML por su <img>.
 *
 * `convert({ tex, mode })` (inyectado; debe aplicar `texForMode` y calcular `mathHash`) devuelve `{ hash, w, h, valign }` o `null`/lanza si
 * no pudo: en ese caso la formula queda con su LaTeX original. La misma formula se convierte
 * una sola vez por llamada. Sin formulas, devuelve el mismo string.
 *
 * @returns {Promise<{ html: string, found: number, converted: number, failed: Array<{ tex: string, error: string }> }>}
 */
export const replaceMath = async (html, convert, { baseUrl = '' } = {}) => {
    const formulas = extractFormulas(html);
    if (formulas.length === 0) return { html, found: 0, converted: 0, failed: [] };

    const pending = new Map();
    const convertOnce = (tex, mode) => {
        const key = `${mode}\u0000${tex}`;
        if (!pending.has(key)) {
            pending.set(key, Promise.resolve()
                .then(() => convert({ tex, mode }))
                .then((result) => ({ result }), (error) => ({ error })));
        }
        return pending.get(key);
    };

    const failed = [];
    let converted = 0;
    let output = '';
    let cursor = 0;

    for (const formula of formulas) {
        const mode = classifyFormula(html, formula);
        const { result, error } = await convertOnce(formula.tex, mode);
        output += html.slice(cursor, formula.start);
        cursor = formula.end;

        if (result?.hash) {
            output += buildMathImg({ ...result, tex: formula.tex, mode }, { baseUrl });
            converted += 1;
        } else {
            output += formula.raw;
            failed.push({ tex: formula.tex, error: error ? String(error.message ?? error) : 'sin resultado' });
        }
    }
    return { html: output + html.slice(cursor), found: formulas.length, converted, failed };
};
