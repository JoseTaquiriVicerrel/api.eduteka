/**
 * Paginas de un PDF como imagenes, y recortes de esas paginas.
 *
 * Es de donde sale la figura que una pregunta importada marca con [IMAGEN]: el
 * PDF de la extraccion (#Services/exam_extraction.service.js) guarda el
 * documento, aqui se rasteriza la pagina y se recorta la zona de la figura.
 *
 * Rasterizar es lo caro (unos 400 ms por pagina), y varias preguntas del mismo
 * examen suelen compartir pagina, asi que la pagina se cachea en disco junto al
 * PDF y solo se recorta en memoria.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import Jimp from 'jimp-compact';

// pdfjs necesita las fuentes estandar y los cmaps para los PDF que no las
// incrustan (muy comun en cuadernillos de examen). Sin esto avisa por consola y
// el texto sale con la tipografia equivocada o directamente en blanco.
//
// Los assets se le piden al pdfjs que carga `pdf-to-img`, no al que resolveria
// este archivo. `pdfjs-dist` no es dependencia nuestra: entra como transitiva y
// no se declara a proposito. Declararla fijaria una version propia, y en cuanto
// divergiera del rango de `pdf-to-img` (hoy `~6.2.108`) npm instalaria dos
// copias: la nuestra arriba y la suya anidada. Las fuentes saldrian de una
// version y el render de la otra, sin error, solo con la tipografia mal.
// Resolviendo desde su entrada seguimos la copia que de verdad se usa, este
// donde este.
const requireFromPdfToImg = createRequire(import.meta.resolve('pdf-to-img'));
// Con barras normales y barra final: pdfjs valida la cadena como URL y rechaza
// la separacion de Windows ("must include trailing slash").
const pdfjsRoot = path.dirname(requireFromPdfToImg.resolve('pdfjs-dist/package.json')).replace(/\\/g, '/');

const DOC_INIT_PARAMS = {
    standardFontDataUrl: `${pdfjsRoot}/standard_fonts/`,
    cMapUrl: `${pdfjsRoot}/cmaps/`,
    cMapPacked: true
};

// 2x sobre el tamano nominal (~150 dpi): suficiente para que el modelo lea una
// figura de examen y para ensenarsela a un revisor, sin inflar la peticion.
export const DEFAULT_SCALE = 2;

/** Carpeta de paginas cacheadas de una extraccion. */
export const pagesDir = (extractionId) => `src/storage/extracciones/${extractionId}/`;

/** PNG de una pagina (1-indexada). No cachea: ver `getPageImage`. */
export const renderPdfPage = async (pdfPath, page, { scale = DEFAULT_SCALE } = {}) => {
    const { pdf } = await import('pdf-to-img');
    const document = await pdf(pdfPath, { scale, docInitParams: DOC_INIT_PARAMS });

    try {
        if (!Number.isInteger(page) || page < 1 || page > document.length) {
            throw new Error(`La pagina ${page} no existe (el PDF tiene ${document.length})`);
        }
        return await document.getPage(page);
    } finally {
        await document.destroy();
    }
};

/**
 * PNG de una pagina, cacheado en disco. Devuelve tambien sus dimensiones, que
 * es lo que permite traducir una caja normalizada a pixeles.
 */
export const getPageImage = async (extractionId, pdfPath, page, { scale = DEFAULT_SCALE } = {}) => {
    const file = `${pagesDir(extractionId)}p${page}.png`;

    let buffer = await fs.readFile(file).catch(() => null);
    if (!buffer) {
        buffer = await renderPdfPage(pdfPath, page, { scale });
        await fs.mkdir(pagesDir(extractionId), { recursive: true });
        await fs.writeFile(file, buffer);
    }

    const image = await Jimp.read(buffer);
    return { buffer, file, width: image.bitmap.width, height: image.bitmap.height };
};

/**
 * Normaliza una caja del modelo a pixeles de la imagen.
 *
 * Gemini devuelve las cajas en la escala 0-1000 y en orden [y0, x0, y1, x1].
 * Como el orden se le olvida a menudo, se acepta tambien [x0, y0, x1, y1]
 * declarandolo en `order`. Se recorta contra los bordes y se exige un area
 * minima: una caja degenerada (la figura entera o cuatro pixeles) es un fallo
 * del modelo, no un recorte.
 */
export const boxToPixels = (box, width, height, { order = 'yxyx', margin = 0.02 } = {}) => {
    if (!Array.isArray(box) || box.length !== 4 || box.some((n) => !Number.isFinite(n))) return null;

    const [a, b, c, d] = box;
    const [x0, y0, x1, y1] = order === 'xyxy' ? [a, b, c, d] : [b, a, d, c];

    const toPixels = (value, size) => Math.round(value / 1000 * size);
    const clamp = (value, max) => Math.max(0, Math.min(max, value));

    // Un poco de aire alrededor: los modelos ajustan la caja al trazo y cortan
    // las etiquetas de los vertices.
    const airX = Math.round(width * margin);
    const airY = Math.round(height * margin);

    const left = clamp(toPixels(Math.min(x0, x1), width) - airX, width);
    const top = clamp(toPixels(Math.min(y0, y1), height) - airY, height);
    const right = clamp(toPixels(Math.max(x0, x1), width) + airX, width);
    const bottom = clamp(toPixels(Math.max(y0, y1), height) + airY, height);

    const cropWidth = right - left;
    const cropHeight = bottom - top;
    if (cropWidth < 40 || cropHeight < 40) return null;
    if (cropWidth * cropHeight > width * height * 0.95) return null;

    return { left, top, width: cropWidth, height: cropHeight };
};

/** Recorta un PNG con una caja ya en pixeles. */
export const cropImage = async (pngBuffer, region) => {
    const image = await Jimp.read(pngBuffer);
    const crop = image.clone().crop(region.left, region.top, region.width, region.height);
    return crop.getBufferAsync('image/png');
};

/** Borra las paginas cacheadas de una extraccion (el PDF no se toca). */
export const clearPagesCache = async (extractionId) => {
    await fs.rm(pagesDir(extractionId), { recursive: true, force: true });
};
