import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js';
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js';

// TeX -> SVG con MathJax 3 (sincrono). Lo ejecuta math_worker.js en un hilo aparte:
// la conversion es CPU pura y un TeX grande puede bloquear ~0,6 s.
//
// Sin el paquete `noundefined`: un comando desconocido debe LANZAR (con noundefined
// se dibuja en rojo y pasaria por valido). Detalles del spike: docs/api-latex-svg-plan.md §4.1.

// MathJax mide con em=16px, ex=8px: el SVG sale en px a ese tamano y las medidas
// relativas (ex) se entregan aparte para que el cliente las escale a su fuente.
const EM = 16;
const EX = 8;
export const MAX_SVG_BYTES = 300 * 1024;

let document_;
let adaptor_;

const setup = () => {
    if (document_) return;
    adaptor_ = liteAdaptor();
    RegisterHTMLHandler(adaptor_);
    document_ = mathjax.document('', {
        InputJax: new TeX({
            packages: ['base', 'ams', 'mhchem', 'cancel'],
            maxMacros: 1000,
            maxBuffer: 5 * 1024,
            formatError: (_jax, error) => { throw new Error(error.message); },
        }),
        OutputJax: new SVG({ fontCache: 'none' }),
    });
};

const ROOT_TAG = /^<svg\b[^>]*>/;
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

// Lo que el SVG no lleva en sus atributos: MathJax lo deja en una hoja CSS que no viaja
// con el archivo, y sin ella las tablas (array, \hline) se pintan como un bloque negro.
const inlineTableStyles = (svg) => svg
    .replace(/<(rect|line)\b([^>]*\bdata-(?:frame|line)\b[^>]*?)>/g, (match, tag, rest) => {
        if (/\sstroke-width=/.test(rest)) return match;
        let extra = ' fill="none" stroke-width="70"';
        if (/class="mjx-dashed"/.test(rest)) extra += ' stroke-dasharray="140"';
        else if (/class="mjx-dotted"/.test(rest)) extra += ' stroke-linecap="round" stroke-dasharray="0,140"';
        return `<${tag}${rest}${extra}>`;
    });

const toPx = (ex) => `${+(Number.parseFloat(ex) * EX).toFixed(3)}px`;

/**
 * Valida y normaliza el SVG de MathJax. Lanza si no es seguro o no es fiable.
 * Devuelve { svg, w, h, valign }: medidas en ex (para el HTML) y SVG con px y sin `style`.
 */
export const finishSvg = (html) => {
    if (html.length > MAX_SVG_BYTES) throw new Error('SVG demasiado grande');
    if (!ROOT_TAG.test(html)) throw new Error('MathJax no devolvio un <svg>');
    if (/<script|<foreignObject|\son[a-z]+\s*=|href\s*=\s*(?:"(?!#)|'(?!#)|[^"'#\s])/i.test(html)) throw new Error('SVG con contenido no permitido');
    if (/data-mjx-error|<merror|fill="red"/.test(html)) throw new Error('MathJax marco error en la formula');
    // <text> depende de la fuente del dispositivo (p. ej. "¿"): mejor dejar el LaTeX.
    if (/<text\b/.test(html)) throw new Error('la formula usa glifos no vectoriales');

    const root = ROOT_TAG.exec(html)[0];
    const w = attr(root, 'width');
    const h = attr(root, 'height');
    const valign = /vertical-align:\s*(-?[\d.]+(?:ex)?)/.exec(attr(root, 'style') ?? '')?.[1] ?? '0';
    if (!w?.endsWith('ex') || !h?.endsWith('ex')) throw new Error('medidas inesperadas en el SVG');

    const newRoot = root
        .replace(/\sstyle="[^"]*"/, '')
        .replace(/\swidth="[^"]*"/, ` width="${toPx(w)}"`)
        .replace(/\sheight="[^"]*"/, ` height="${toPx(h)}"`);
    return {
        svg: inlineTableStyles(newRoot + html.slice(root.length)),
        w,
        h,
        valign: /ex$/.test(valign) ? valign : `${valign}${valign === '0' ? '' : 'ex'}`,
    };
};

/**
 * Convierte un TeX (ya preparado con texForMode) a SVG.
 * @param {{ tex: string, display: boolean }} input
 * @returns {{ svg: string, w: string, h: string, valign: string }}
 */
export const renderSvg = ({ tex, display }) => {
    setup();
    const node = document_.convert(tex, { display, em: EM, ex: EX, containerWidth: 1280 });
    return finishSvg(adaptor_.outerHTML(adaptor_.firstChild(node)));
};
