import http from 'node:http';
import mongoose from 'mongoose';
import { settings } from '#Config/settings.js';
import { createWorker, pingQueueRedis } from '#Config/queue.js';
import { logger } from '#Libs/logger.js';
import { QUEUES } from '#Libs/queue_contracts.js';
import { runProcess } from './bootstrap.js';

// Proceso de fondo: consume las colas de api_eduteka (plan de separacion de servicios, fases 1-4).
// En la Fase 0 solo atiende la cola `system` (ping), para comprobar de extremo a extremo que
// encolar, procesar y sobrevivir a un reinicio funciona antes de mover trabajo real aqui.
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

// Salud en 127.0.0.1: Mongo conectado y Redis de colas respondiendo. 503 si falla alguno.
const startHealthServer = () => {
    const server = http.createServer(async (req, res) => {
        if (req.url !== '/health') {
            res.writeHead(404).end();
            return;
        }
        const mongo = mongoose.connection.readyState === 1;
        const queue = await pingQueueRedis().then((reply) => reply === 'PONG').catch(() => false);
        const ok = mongo && queue;
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', process: 'worker', mongo, queue }));
    });
    server.listen(settings.worker.healthPort, '127.0.0.1', () => {
        logger.info({ port: settings.worker.healthPort }, 'Salud del worker escuchando');
    });
    return server;
};

runProcess('worker', async () => {
    if (!settings.queue.enabled) throw new Error('El worker necesita QUEUE_ENABLED=true');
    // Falla rapido si el Redis de colas no esta: systemd reintenta (Restart=always).
    await pingQueueRedis(5_000);

    const workers = [createWorker(QUEUES.SYSTEM, systemHandlers, { concurrency: 1 })];
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    logger.info({ queues: [QUEUES.SYSTEM], prefix: settings.queue.prefix }, 'Worker listo');

    const health = startHealthServer();

    return async () => {
        await new Promise((done) => health.close(() => done()));
        // Los workers se cierran en closeQueues() (bootstrap), esperando los trabajos en curso.
    };
}, { requireRedis: true });
