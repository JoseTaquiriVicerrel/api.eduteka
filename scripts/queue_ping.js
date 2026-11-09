// Comprobacion de extremo a extremo de las colas: encola un `system/ping` y espera a que el
// worker (src/worker.js) lo procese. Sale con 0 si llega la respuesta y con 1 si no.
//
//   QUEUE_ENABLED=true node scripts/queue_ping.js            # espera 10 s
//   QUEUE_ENABLED=true node scripts/queue_ping.js --wait=30
//
// Para probar que un trabajo sobrevive a un reinicio: parar el worker, encolar con --wait=60,
// volver a arrancar el worker y ver que la respuesta llega.

import '#Config/env.js';
import { closeQueues, enqueue, getQueueEvents } from '#Config/queue.js';
import { CONTRACT_VERSION, QUEUES } from '#Libs/queue_contracts.js';

const waitArg = process.argv.find((arg) => arg.startsWith('--wait='));
const waitSeconds = Number(waitArg?.split('=')[1] ?? 10);

// Los eventos usan una conexion de consumidor, que espera a Redis indefinidamente: aqui se acota.
const withTimeout = (promise, ms, message) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

const main = async () => {
    const events = getQueueEvents(QUEUES.SYSTEM);
    await withTimeout(events.waitUntilReady(), Math.min(waitSeconds, 5) * 1000, 'Redis de colas no disponible (eventos)');

    const sentAt = new Date().toISOString();
    const job = await enqueue(QUEUES.SYSTEM, 'ping', { v: CONTRACT_VERSION, sent_at: sentAt, from: 'queue_ping' }, { attempts: 1 });
    console.log(`Encolado system/ping #${job.id}; esperando hasta ${waitSeconds} s...`);

    const result = await job.waitUntilFinished(events, waitSeconds * 1000);
    const elapsed = Date.now() - new Date(sentAt).getTime();
    console.log(`Respuesta del worker (pid ${result.pid}) en ${elapsed} ms:`, result);
};

main()
    .then(async () => { await closeQueues(); process.exit(0); })
    .catch(async (error) => {
        console.error('Fallo:', error?.message ?? error);
        await closeQueues().catch(() => {});
        process.exit(1);
    });
