import mongoose from 'mongoose';
import { settings } from '#Config/settings.js';
import { createWorker, pingQueueRedis } from '#Config/queue.js';
import { logger } from '#Libs/logger.js';
import { closeServer, startHealthServer } from '#Libs/process_health.js';
import { QUEUES } from '#Libs/queue_contracts.js';
import { gradingHandlers } from '#Modules/simulacra/scheduler/simulacrum.scheduler.js';
import { runProcess } from './bootstrap.js';

// Proceso de fondo: consume las colas de trabajo de api_eduteka (plan de separacion de servicios).
//
//   system               ping de comprobacion (scripts/queue_ping.js)
//   simulacrum-grading   calificacion de cada intento abierto al cerrar una ventana (Fase 1)
//
//   QUEUE_ENABLED=true node src/worker.js
//   curl -s http://127.0.0.1:3003/health

const systemHandlers = {
    ping: async (job) => ({
        received_at: new Date().toISOString(),
        sent_at: job.data.sent_at,
        from: job.data.from,
        pid: process.pid,
    }),
};

runProcess('worker', async () => {
    if (!settings.queue.enabled) throw new Error('El worker necesita QUEUE_ENABLED=true');
    // Falla rapido si el Redis de colas no esta: systemd reintenta (Restart=always).
    await pingQueueRedis(5_000);

    const workers = [
        createWorker(QUEUES.SYSTEM, systemHandlers, { concurrency: 1 }),
        createWorker(QUEUES.SIMULACRUM_GRADING, gradingHandlers, { concurrency: settings.worker.gradingConcurrency }),
    ];
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    logger.info({ queues: [QUEUES.SYSTEM, QUEUES.SIMULACRUM_GRADING], prefix: settings.queue.prefix }, 'Worker listo');

    const health = startHealthServer({
        name: 'worker',
        port: settings.worker.healthPort,
        checks: {
            mongo: async () => mongoose.connection.readyState === 1,
            queue: async () => (await pingQueueRedis()) === 'PONG',
        },
    });

    // Los workers se cierran en closeQueues() (bootstrap), esperando los trabajos en curso.
    return async () => closeServer(health);
}, { requireRedis: true });
