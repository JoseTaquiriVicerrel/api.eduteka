import { settings } from '#Config/settings.js';
import { createWorker, pingQueueRedis } from '#Config/queue.js';
import { logger } from '#Libs/logger.js';
import { objectStorage } from '#Libs/object_storage.js';
import { closeServer, startHealthServer } from '#Libs/process_health.js';
import { QUEUES } from '#Libs/queue_contracts.js';
import { createBrowserManager } from '#Modules/docs/chromium.js';
import { findDocxEngine } from '#Modules/docs/docx.js';
import { createDocsHandlers } from '#Modules/docs/docs.handlers.js';
import { runProcess } from './bootstrap.js';

// edk-docs: imprime documentos fuera de los procesos web (plan de separacion de servicios, Fase 2).
// Consume la cola `docs`: HTML -> PDF con un Chromium compartido y DOCX -> PDF con LibreOffice.
// No usa Mongo ni el Redis de cache: solo el Redis de colas y el almacenamiento de objetos.
//
//   QUEUE_ENABLED=true DOCS_CHROMIUM_PATH=/usr/bin/chromium-browser node src/docs.js
//   curl -s http://127.0.0.1:3005/health

runProcess('docs', async () => {
    if (!settings.queue.enabled) throw new Error('edk-docs necesita QUEUE_ENABLED=true');
    await pingQueueRedis(5_000);

    const browserManager = createBrowserManager();
    const worker = createWorker(QUEUES.DOCS, createDocsHandlers({ browserManager }), { concurrency: settings.docs.concurrency });
    await worker.waitUntilReady();

    // Calienta Chromium al arrancar: el primer lanzamiento tarda (en Windows, decenas de segundos) y no
    // debe pagarlo el primer documento que alguien pida. Si falla, el primer trabajo lo reintenta.
    if (settings.docs.chromiumPath) {
        const warmStart = Date.now();
        browserManager.withPage(async () => {})
            .then(() => logger.info({ ms: Date.now() - warmStart }, 'Chromium listo'))
            .catch((error) => logger.warn({ err: error?.message }, 'No se pudo calentar Chromium'));
    }

    const docxEngine = findDocxEngine();
    logger.info({
        queue: QUEUES.DOCS,
        concurrency: settings.docs.concurrency,
        chromium: settings.docs.chromiumPath ?? '(sin configurar)',
        docx: docxEngine?.name ?? '(sin motor)',
        storage: objectStorage.driver,
    }, 'edk-docs listo');

    const health = startHealthServer({
        name: 'docs',
        port: settings.docs.healthPort,
        checks: {
            queue: async () => (await pingQueueRedis()) === 'PONG',
            worker: async () => worker.isRunning(),
            chromium: async () => Boolean(settings.docs.chromiumPath),
        },
    });

    return async () => {
        await closeServer(health);
        // El worker (y sus trabajos en curso) se cierra en closeQueues(); despues, el navegador.
        await worker.close();
        await browserManager.close();
    };
}, { mongo: false });
