// Cliente de edk-docs para los procesos HTTP de la API (el monolito tiene el suyo:
// eduteka/src/libs/docs_client.js, con las mismas claves y el mismo trabajo `print-pdf`).
//
// El HTML va al almacenamiento de objetos (compartido con edk-docs) y por la cola solo su clave.
// La salida es el hash del contenido: lo ya impreso sale del almacenamiento sin encolar, y dos
// peticiones iguales a la vez comparten un solo trabajo.
//
// Nunca deja colgada una peticion: con las colas apagadas, Redis caido o edk-docs sin responder en
// DOCS_WAIT_MS lanza DocsUnavailableError, y quien llama decide su respaldo.

import { createHash } from 'node:crypto';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { settings } from '#Config/settings.js';
import { QueueDisabledError, QueueUnavailableError, enqueue, getQueue, getQueueEvents } from '#Config/queue.js';
import { objectStorage as defaultStorage } from '#Libs/object_storage.js';
import { CONTRACT_VERSION, QUEUES } from '#Libs/queue_contracts.js';

// Mismo valor que el monolito: si cambia como se imprime, cambian las claves de los dos.
export const PRINT_FORMAT_VERSION = 1;

export class DocsUnavailableError extends Error {
    constructor(detail) {
        super(`edk-docs no disponible${detail ? `: ${detail}` : ''}`);
        this.name = 'DocsUnavailableError';
    }
}

const readOutput = async (storage, key) => {
    const object = await storage.get(key);
    return object ? streamToBuffer(object.body) : null;
};

const withTimeout = (promise, ms, message) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new DocsUnavailableError(message)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

/** Clave de salida de un HTML impreso. Misma cuenta que el monolito (printPdf de su docs_client). */
export const printOutputHash = ({ html, title, headerFooter, watermark }) => createHash('sha256')
    .update(String(PRINT_FORMAT_VERSION)).update('\0')
    .update(title).update('\0')
    .update(headerFooter ? '1' : '0').update(watermark ? '1' : '0').update('\0')
    .update(html)
    .digest('hex');

/**
 * Encola `print-pdf` (o se une al trabajo con el mismo `jobId`) y espera a que termine.
 * Todo lo que salga mal aqui es "edk-docs no disponible": colas apagadas, Redis caido, sin
 * respuesta a tiempo o un trabajo que fallo (motor ausente, HTML roto). Quien llama tiene un
 * respaldo, y un fallo del servicio no puede convertirse en un 500 para el usuario.
 *
 * Un trabajo fallido se borra antes de avisar: con el mismo `jobId` seguiria devolviendo ese fallo
 * (BullMQ no vuelve a encolar un id retenido) aunque el motor ya se hubiera arreglado.
 */
const defaultRunner = {
    async run({ data, jobId, waitMs }) {
        try {
            // Primero encolar: sin Redis falla al instante (productor sin cola offline). Abrir antes los
            // eventos haria esperar a una conexion que no vuelve.
            const job = await enqueue(QUEUES.DOCS, 'print-pdf', data, { jobId, attempts: 2, backoff: { type: 'fixed', delay: 1_000 } });
            const events = getQueueEvents(QUEUES.DOCS);
            await withTimeout(events.waitUntilReady(), 2_000, 'eventos de la cola sin conexion');
            try {
                await job.waitUntilFinished(events, waitMs);
            } catch (error) {
                if (/timed out/i.test(error?.message ?? '')) throw new DocsUnavailableError(`sin respuesta en ${waitMs} ms`);
                await job.remove().catch(() => {});
                throw new DocsUnavailableError(`el trabajo fallo: ${error?.message ?? error}`);
            }
        } catch (error) {
            if (error instanceof DocsUnavailableError) throw error;
            if (error instanceof QueueDisabledError || error instanceof QueueUnavailableError) throw new DocsUnavailableError(error.message);
            throw error;
        }
    },
    /** Borra un trabajo terminado cuyo resultado ya no existe (se borro del almacenamiento). */
    async discard(jobId) {
        await getQueue(QUEUES.DOCS).getJob(jobId).then((job) => job?.remove()).catch(() => {});
    },
};

/** HTML ya armado -> PDF (Buffer), impreso por edk-docs. */
export const printPdf = async ({ html, title = '', headerFooter = true, watermark = headerFooter }, {
    storage = defaultStorage, waitMs = settings.docs.waitMs, runner = defaultRunner,
} = {}) => {
    if (!settings.queue.enabled) throw new DocsUnavailableError('colas apagadas (QUEUE_ENABLED=false)');

    const safeTitle = String(title).slice(0, 300);
    const hash = printOutputHash({ html, title: safeTitle, headerFooter, watermark });
    const outputKey = `pdf/print/${hash}.pdf`;
    const cached = await readOutput(storage, outputKey);
    if (cached) return cached;

    const htmlKey = `docs/in/${hash}.html`;
    await storage.put(htmlKey, Buffer.from(html, 'utf8'), { contentType: 'text/html' });
    const data = { v: CONTRACT_VERSION, html_key: htmlKey, output_key: outputKey, title: safeTitle, header_footer: headerFooter, watermark, self_contained: true };
    const jobId = `print.${hash}`;

    // Si el trabajo ya estaba terminado pero su PDF se borro, se rehace una vez: el id retenido no
    // volveria a imprimir y la lista se quedaria con el respaldo hasta que expire el trabajo.
    for (let round = 0; round < 2; round += 1) {
        await runner.run({ data, jobId, waitMs });
        const pdf = await readOutput(storage, outputKey);
        if (pdf) return pdf;
        await runner.discard(jobId);
        // El manejador borra el HTML de entrada al terminar: se vuelve a subir para la segunda vuelta.
        await storage.put(htmlKey, Buffer.from(html, 'utf8'), { contentType: 'text/html' });
    }
    throw new DocsUnavailableError(`termino pero no existe ${outputKey}`);
};
