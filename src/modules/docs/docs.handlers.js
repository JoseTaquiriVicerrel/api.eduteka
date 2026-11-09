// Manejadores de la cola `docs` (los consume src/docs.js).
//
// Entrada y salida van por el almacenamiento de objetos (#Libs/object_storage.js), no por la cola:
// un examen con imagenes incrustadas pesa varios MB. La clave de salida la fija quien pide y es
// determinista (hash del contenido), asi que un documento ya impreso no se vuelve a imprimir.

import { UnrecoverableError } from 'bullmq';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { objectStorage as defaultStorage } from '#Libs/object_storage.js';
import { logger } from '#Libs/logger.js';
import { DocxEngineUnavailableError, convertDocx } from './docx.js';
import { pageCount, printHtml } from './print.js';
import { ChromiumUnavailableError } from './chromium.js';

const readObject = async (storage, key) => {
    const object = await storage.get(key);
    // Sin la entrada no hay nada que reintentar: quien encolo la borro o nunca la subio.
    if (!object) throw new UnrecoverableError(`No existe la entrada ${key}`);
    return streamToBuffer(object.body);
};

// Un motor que falta no se arregla reintentando: falla el trabajo de inmediato y con el motivo.
const unrecoverableIfMissingEngine = (error) => {
    if (error instanceof ChromiumUnavailableError || error instanceof DocxEngineUnavailableError) {
        throw new UnrecoverableError(error.message);
    }
    throw error;
};

export const createDocsHandlers = ({ browserManager, storage = defaultStorage, docx = convertDocx } = {}) => ({
    'print-pdf': async (job) => {
        const { html_key: htmlKey, output_key: outputKey, title, header_footer: headerFooter, watermark, self_contained: selfContained } = job.data;
        if (await storage.exists(outputKey)) return { key: outputKey, cached: true };

        const started = Date.now();
        const html = (await readObject(storage, htmlKey)).toString('utf8');
        const pdf = await printHtml(browserManager, html, { title, headerFooter, watermark, selfContained }).catch(unrecoverableIfMissingEngine);
        await storage.put(outputKey, pdf, { contentType: 'application/pdf' });
        // La entrada ya no sirve: el resultado queda guardado con su clave.
        await storage.delete(htmlKey).catch(() => {});

        const pages = await pageCount(pdf);
        logger.info({ key: outputKey, bytes: pdf.length, pages, ms: Date.now() - started }, 'PDF impreso');
        return { key: outputKey, bytes: pdf.length, pages, cached: false };
    },

    'docx-pdf': async (job) => {
        const { docx_key: docxKey, output_key: outputKey } = job.data;
        if (await storage.exists(outputKey)) return { key: outputKey, cached: true };

        const started = Date.now();
        const source = await readObject(storage, docxKey);
        const pdf = await docx(source).catch(unrecoverableIfMissingEngine);
        await storage.put(outputKey, pdf, { contentType: 'application/pdf' });

        const pages = await pageCount(pdf);
        logger.info({ key: outputKey, bytes: pdf.length, pages, ms: Date.now() - started }, 'DOCX convertido a PDF');
        return { key: outputKey, bytes: pdf.length, pages, cached: false };
    },
});
