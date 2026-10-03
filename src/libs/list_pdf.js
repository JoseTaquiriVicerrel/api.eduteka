import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// PDF de una lista de preguntas con pdf-lib (sin navegador).
//
// LIMITACION CONOCIDA: pdf-lib no renderiza HTML ni formulas. El PDF de la web se genera
// con Chromium + MathJax; este es un PDF de TEXTO:
//   - las etiquetas HTML se quitan y los saltos de linea se conservan;
//   - las imagenes se sustituyen por la marca "[imagen]";
//   - las formulas LaTeX salen como texto plano (\frac{a}{b});
//   - los simbolos fuera de WinAnsi (la fuente estandar) se transliteran o salen como "?".
// Sirve para repasar sin conexion; para material con mucha matematica conviene el PDF de la web.

const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = 50;
const BODY = { size: 11, leading: 15 };
const INK = rgb(0.12, 0.16, 0.2);
const MUTED = rgb(0.4, 0.45, 0.5);

const ENTITIES = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '-', mdash: '-', hellip: '...',
    // Vocales con tilde, eñe y signos del español.
    aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
    ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿', deg: '°', times: '×', divide: '÷',
};

// Simbolos habituales que la fuente estandar no tiene.
const TRANSLITERATION = {
    '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '−': '-', '√': 'raiz', '∞': 'infinito', 'π': 'pi', 'Δ': 'Delta',
    'α': 'alfa', 'β': 'beta', 'θ': 'theta', 'λ': 'lambda', 'μ': 'mu', 'σ': 'sigma', 'Ω': 'Omega', 'ω': 'omega',
    '∑': 'suma', '∫': 'integral', '→': '->', '←': '<-', '⇒': '=>', '∈': 'en', '∪': 'U', '∩': 'n', '·': '.',
    '“': '"', '”': '"', '‘': "'", '’': "'", ' ': ' ', '\t': ' ',
};

/** HTML del editor -> texto plano (con saltos de linea). */
export const htmlToText = (html) => {
    if (typeof html !== 'string') return '';

    return html
        .replace(/<img[^>]*>/gi, ' [imagen] ')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? match)
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

const makeWriter = (doc, font, bold) => {
    const supported = new Set(font.getCharacterSet());
    const encodable = (text) => Array.from(text.normalize('NFC'), (char) => {
        if (supported.has(char.codePointAt(0))) return char;
        return TRANSLITERATION[char] ?? '?';
    }).join('');

    let page = doc.addPage([PAGE.width, PAGE.height]);
    let y = PAGE.height - MARGIN;
    const width = PAGE.width - MARGIN * 2;

    const ensure = (needed) => {
        if (y - needed >= MARGIN) return;
        page = doc.addPage([PAGE.width, PAGE.height]);
        y = PAGE.height - MARGIN;
    };

    // Parte el texto en lineas que caben en el ancho (corta palabras que no caben solas).
    const wrap = (text, usedFont, size, maxWidth) => {
        const lines = [];
        for (const paragraph of encodable(text).split('\n')) {
            let line = '';
            for (const word of paragraph.split(' ')) {
                let rest = word;
                while (usedFont.widthOfTextAtSize(rest, size) > maxWidth) {
                    let cut = rest.length - 1;
                    while (cut > 1 && usedFont.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut -= 1;
                    if (line) { lines.push(line); line = ''; }
                    lines.push(rest.slice(0, cut));
                    rest = rest.slice(cut);
                }
                const candidate = line ? `${line} ${rest}` : rest;
                if (usedFont.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
                else { lines.push(line); line = rest; }
            }
            lines.push(line);
        }
        return lines;
    };

    const write = (text, { bold: isBold = false, size = BODY.size, leading = BODY.leading, indent = 0, color = INK } = {}) => {
        const usedFont = isBold ? bold : font;
        for (const line of wrap(text, usedFont, size, width - indent)) {
            ensure(leading);
            y -= leading;
            if (line) page.drawText(line, { x: MARGIN + indent, y, size, font: usedFont, color });
        }
    };

    return { write, gap: (points) => { y -= points; }, ensure };
};

/**
 * @param {object} args
 * @param {string} args.title
 * @param {string} [args.description]
 * @param {{ question: string, options: {key: string, text: string}[], correct?: string|null }[]} args.questions
 * @param {boolean} [args.includeAnswers] anade al final la clave de respuestas.
 * @returns {Promise<Buffer>}
 */
export const buildListPdf = async ({ title, description, questions, includeAnswers = false }) => {
    const doc = await PDFDocument.create();
    doc.setTitle(String(title).slice(0, 200));
    doc.setProducer('Eduteka');
    doc.setCreator('Eduteka');

    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const out = makeWriter(doc, font, bold);

    out.write(title, { bold: true, size: 18, leading: 24 });
    if (description) out.write(htmlToText(description), { color: MUTED });
    out.gap(8);

    questions.forEach((item, index) => {
        out.ensure(BODY.leading * 4);
        out.write(`${index + 1}. ${htmlToText(item.question)}`, { bold: false });
        for (const option of item.options) out.write(`${option.key}) ${htmlToText(option.text)}`, { indent: 18 });
        out.gap(10);
    });

    if (includeAnswers) {
        out.gap(6);
        out.ensure(BODY.leading * 3);
        out.write('Clave de respuestas', { bold: true, size: 14, leading: 20 });
        out.write(questions.map((item, index) => `${index + 1}-${item.correct ?? '?'}`).join('   '));
    }

    // Pie con la numeracion, una vez que se sabe el total de paginas.
    const pages = doc.getPages();
    pages.forEach((page, index) => {
        page.drawText(`Eduteka  ·  ${index + 1}/${pages.length}`, { x: MARGIN, y: 28, size: 9, font, color: MUTED });
    });

    return Buffer.from(await doc.save());
};
