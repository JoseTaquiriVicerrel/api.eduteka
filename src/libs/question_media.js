/**
 * Adjuntos visuales de una pregunta para las llamadas al modelo.
 *
 * Muchas preguntas del banco NO se pueden resolver solo con texto: la figura, el
 * grafico o la tabla vive en un `<img>` dentro del enunciado o de una opcion.
 * Hasta ahora `#Services/ai-batch-processor.service.js` mandaba a Gemini el HTML
 * tal cual, asi que el modelo veia una etiqueta `<img src="/images/questions/x.png">`
 * y respondia igualmente: inventaba la alternativa correcta sobre una figura que
 * nunca vio. Este modulo hace dos cosas:
 *
 *   1. Sustituye cada `<img>` por un marcador `[IMAGEN n]` en el texto que se
 *      serializa al prompt. Ademas de dar al modelo una referencia estable,
 *      evita mandar megabytes de base64 dentro del JSON: quedan preguntas con la
 *      imagen incrustada como `data:image/...;base64` que
 *      scripts/migrate_base64_images.js todavia no ha pasado a fichero.
 *   2. Devuelve los bytes de cada imagen como `inlineData`, listos para
 *      adjuntarse al mismo turno de usuario.
 *
 * Lo mismo vale para el texto de la lectura enlazada (`question.dependence`),
 * que tambien lleva figuras: ver `buildBlockMedia`.
 *
 * Las URLs guardadas son relativas (`/images/questions/x.png`) porque asi las
 * extrae el pre-save de #Schemas/questions_schema.js, pero tambien hay absolutas
 * (`https://eduteka.pe/images/questions/x.png`, ver `saveImagesBase64` en
 * #Libs/functions.js) y `data:`. Se cubren los tres casos: fichero local primero
 * -los scripts se ejecutan desde el repo, que trae el mismo `src/public`- y
 * descarga HTTP como respaldo cuando el fichero no esta en este checkout.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteUrl } from '#Libs/api/urls.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

// Mismo criterio que el pre-save del esquema: solo `<img>`, con el src entre
// comillas simples o dobles.
const IMG_TAG_RE = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;

const MARKER_RE = /\[IMAGEN\s+(\d+)\]/gi;

const DATA_URI_RE = /^data:([^;,]+);base64,(.+)$/is;

const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp'
};

// Gemini admite hasta 20 MB de peticion inline. El tope va holgado por debajo:
// una figura de examen escaneado ronda los 100 KB.
const MAX_BYTES_PER_IMAGE = 4 * 1024 * 1024;

const mimeFromUrl = (url) => {
    const ext = path.extname(url.split(/[?#]/)[0]).toLowerCase();
    return MIME_BY_EXT[ext] ?? 'image/png';
};

/**
 * Ruta en disco de una imagen servida desde `src/public`, o null si el src
 * apunta fuera de ahi (un CDN de terceros, por ejemplo).
 *
 * Acepta la ruta relativa y la absoluta del propio sitio: de una URL absoluta se
 * queda con el pathname, que es justo lo que cuelga de `src/public`.
 */
const localPathFor = (src) => {
    let pathname = src;

    if (/^https?:\/\//i.test(src)) {
        try {
            pathname = new URL(src).pathname;
        } catch {
            return null;
        }
    }

    if (!pathname.startsWith('/')) return null;

    let decoded = pathname;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        // src mal escapado: se usa tal cual.
    }

    const resolved = path.resolve(PUBLIC_DIR, `.${decoded}`);

    // Un `..` dentro del src no puede sacarnos de src/public.
    return resolved.startsWith(PUBLIC_DIR) ? resolved : null;
};

/**
 * Bytes de una imagen en base64, o null si no se pudo obtener. Nunca lanza: una
 * imagen inaccesible degrada esa pregunta a "sin adjunto", no tumba el lote.
 */
const readImage = async (src) => {
    const dataUri = DATA_URI_RE.exec(src.trim());
    if (dataUri) {
        return { mimeType: dataUri[1], data: dataUri[2].replace(/\s+/g, '') };
    }

    const mimeType = mimeFromUrl(src);

    const localPath = localPathFor(src);
    if (localPath) {
        try {
            const buffer = await fs.readFile(localPath);
            if (buffer.length === 0 || buffer.length > MAX_BYTES_PER_IMAGE) return null;
            return { mimeType, data: buffer.toString('base64') };
        } catch {
            // No esta en este checkout: se intenta por HTTP mas abajo.
        }
    }

    // `absoluteUrl` deja intactas las que ya lo son y antepone el dominio
    // publico a las relativas, que es de donde las sirve produccion.
    const url = absoluteUrl(src);
    if (!/^https?:\/\//i.test(url)) return null;

    try {
        const response = await fetch(url);
        if (!response.ok) return null;

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0 || buffer.length > MAX_BYTES_PER_IMAGE) return null;

        const header = response.headers.get('content-type')?.split(';')[0]?.trim();
        return { mimeType: header?.startsWith('image/') ? header : mimeType, data: buffer.toString('base64') };
    } catch {
        return null;
    }
};

const optionEntries = (options) => {
    if (!options) return [];
    if (options instanceof Map) return [...options.entries()];
    if (typeof options === 'object') return Object.entries(options);
    return [];
};

/**
 * Cuenta los `<img>` de un fragmento de HTML sin leer ningun fichero.
 */
export const countHtmlImages = (text) => {
    if (!text || typeof text !== 'string') return 0;
    return [...text.matchAll(IMG_TAG_RE)].length;
};

/**
 * Cuenta los `<img>` del enunciado y de las opciones. NO incluye los de la
 * lectura (`dependence`), que se cuentan aparte porque una misma lectura la
 * comparten varias preguntas y sus imagenes se adjuntan una sola vez por lote.
 * Sirve para los conteos del dry-run de scripts/enqueue_ai_review.js.
 */
export const countQuestionImages = (question) => {
    let total = countHtmlImages(question?.question);
    for (const [, value] of optionEntries(question?.options)) total += countHtmlImages(value);
    return total;
};

/**
 * Reemplaza cada `<img>` por su marcador y acumula la etiqueta original en
 * `refs`, en el mismo orden en el que se numeran. El resto del HTML se deja
 * intacto: el modelo ya venia trabajando con el (tablas, sub/sup, LaTeX).
 *
 * `prefix` separa los dos espacios de numeracion: `IMAGEN` para lo que es de la
 * pregunta e `IMAGEN LECTURA` para lo que es del texto compartido. Sin esa
 * separacion, la figura 1 de la lectura y la figura 1 del enunciado se llamarian
 * igual dentro del mismo lote y `restoreImages` podria devolver el `<img>` que
 * no era al reconstruir la sugerencia.
 */
const replaceImages = (text, refs, label, prefix = 'IMAGEN') => {
    if (!text || typeof text !== 'string') return text;

    return text.replace(IMG_TAG_RE, (tag, src) => {
        refs.push({ n: refs.length + 1, tag, src, label });
        return `[${prefix} ${refs.length}]`;
    });
};

/**
 * Carga los bytes de cada ref y los convierte en `parts`. Delante de cada imagen
 * va un texto con su marcador: es lo que la ata al `[IMAGEN n]` del enunciado o
 * de la lectura. Devuelve tambien los marcadores que no se pudieron cargar.
 */
const attachRefs = async (refs, { prefix = 'IMAGEN', owner }) => {
    const parts = [];
    const missing = [];

    for (const ref of refs) {
        const image = await readImage(ref.src);

        if (!image) {
            missing.push(`[${prefix} ${ref.n}]`);
            continue;
        }

        parts.push({ text: `[${prefix} ${ref.n}] de ${owner} (${ref.label}):` });
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }

    return { parts, missing };
};

/**
 * Version de la pregunta lista para el prompt.
 *
 * Devuelve el enunciado y las opciones con los `<img>` ya sustituidos por
 * marcadores, y las `parts` de imagen correspondientes. `missing` son los
 * marcadores cuya imagen no se pudo cargar: se le nombran al modelo para que
 * marque `needs_manual_review` en vez de resolver a ciegas.
 */
export const buildQuestionMedia = async (question) => {
    const refs = [];

    const text = replaceImages(question.question, refs, 'enunciado');

    const options = {};
    for (const [key, value] of optionEntries(question.options)) {
        options[key] = replaceImages(value, refs, `opcion ${key}`);
    }

    const { parts, missing } = await attachRefs(refs, { owner: `la pregunta ${question._id}` });

    return { id: question._id, question: text, options, refs, parts, missing, total: refs.length };
};

/**
 * Version de la lectura (`question.dependence`) lista para el prompt.
 *
 * Las preguntas de comprension lectora no se pueden resolver sin su texto: el
 * enunciado dice "segun el autor..." y el texto vive en el bloque enlazado. Se
 * construye aparte de la pregunta porque una misma lectura la comparten hasta
 * diez preguntas del mismo lote: se manda una sola vez y cada pregunta la
 * referencia por `lectura_id`.
 *
 * Sus imagenes usan el prefijo `IMAGEN LECTURA` para no chocar con la
 * numeracion del enunciado.
 */
export const buildBlockMedia = async (dependence) => {
    const refs = [];
    const text = replaceImages(dependence.text, refs, 'lectura', 'IMAGEN LECTURA');

    const { parts, missing } = await attachRefs(refs, {
        prefix: 'IMAGEN LECTURA',
        owner: `la lectura ${dependence.id}`
    });

    return {
        id: dependence.id,
        title: dependence.title ?? null,
        text,
        refs,
        parts,
        missing,
        total: refs.length
    };
};

/**
 * Deshace la sustitucion sobre el texto que devuelve el modelo: cada
 * `[IMAGEN n]` vuelve a ser su `<img>` original.
 *
 * Es imprescindible antes de guardar `ai_suggestion.question`. La sugerencia se
 * aplica copiandola sobre `question`, asi que guardarla con los marcadores
 * significaria borrar las imagenes de la pregunta en cuanto un revisor la
 * acepte. Un marcador que el modelo se haya inventado (o movido a una pregunta
 * que no era) no tiene `<img>` detras y se deja tal cual, visible para el
 * revisor.
 */
export const restoreImages = (text, media) => {
    if (!text || typeof text !== 'string' || !media?.refs?.length) return text;

    const byNumber = new Map(media.refs.map((ref) => [ref.n, ref.tag]));

    return text.replace(MARKER_RE, (marker, n) => byNumber.get(Number(n)) ?? marker);
};

export default { buildQuestionMedia, countQuestionImages, restoreImages };
