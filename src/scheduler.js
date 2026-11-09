import mongoose from 'mongoose';
import SimulacrumModel from '#Models/simulacrum_model.js';
import { settings } from '#Config/settings.js';
import { createWorker, enqueue, pingQueueRedis } from '#Config/queue.js';
import { logger } from '#Libs/logger.js';
import { closeServer, startHealthServer } from '#Libs/process_health.js';
import { CONTRACT_VERSION, QUEUES } from '#Libs/queue_contracts.js';
import { closeBus, subscribe } from '#Modules/simulacra/realtime/simulacrum.events.js';
import { ensureReconcileSchedule, reconcileOne, schedulerHandlers } from '#Modules/simulacra/scheduler/simulacrum.scheduler.js';
import { runProcess } from './bootstrap.js';

// edk-scheduler: el reloj de los simulacros programados (plan de separacion de servicios, Fase 1).
// Consume la cola `simulacrum` (hitos, reconcile, cierre) y escucha la senal `updated` que publica
// el panel del monolito al cambiar fechas. La calificacion de cada intento la hace src/worker.js.
//
// Sin lider: los hitos son trabajos con id determinista y cada manejador es idempotente, asi que
// dos replicas no ejecutan nada dos veces.
//
// Interruptor del monolito: con este proceso en marcha, el monolito corre con
// SIMULACRUM_CLOCK=external (deja de programar temporizadores y de cerrar ventanas).

runProcess('scheduler', async () => {
    if (!settings.queue.enabled) throw new Error('El scheduler necesita QUEUE_ENABLED=true');
    await pingQueueRedis(5_000);

    const worker = createWorker(QUEUES.SIMULACRUM, schedulerHandlers, { concurrency: settings.scheduler.concurrency });
    await worker.waitUntilReady();

    await ensureReconcileSchedule();
    // Al arrancar se pone al dia lo que paso con el proceso apagado (como el reconcile del monolito).
    await enqueue(QUEUES.SIMULACRUM, 'reconcile', { v: CONTRACT_VERSION }, { attempts: 1 });

    // El admin cambio fechas (o cerro / publico a mano): se reprograma ese simulacro.
    const unsubscribe = subscribe(async (signal) => {
        if (signal.type !== 'updated') return;
        const sim = await SimulacrumModel.findById(signal.simulacrum_id).lean().exec();
        if (sim) await reconcileOne(sim);
    });

    const health = startHealthServer({
        name: 'scheduler',
        port: settings.scheduler.healthPort,
        checks: {
            mongo: async () => mongoose.connection.readyState === 1,
            queue: async () => (await pingQueueRedis()) === 'PONG',
            worker: async () => worker.isRunning(),
        },
    });
    logger.info({ queue: QUEUES.SIMULACRUM, prefix: settings.queue.prefix }, 'Scheduler listo');

    return async () => {
        unsubscribe();
        await closeBus();
        await closeServer(health);
    };
}, { requireRedis: true });
