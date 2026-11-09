// Colas encendidas pero sin Redis de colas (nada escucha en el puerto 1): quien encola desde una
// peticion HTTP no puede quedarse colgado, y el apagado tampoco.
// helpers/env.js impone QUEUE_ENABLED=false: se pisa DESPUES de cargarlo y ANTES de que
// #Config/settings.js se lea (lo cargan los import dinamicos de abajo).
await import('./helpers/env.js');
Object.assign(process.env, {
    QUEUE_ENABLED: 'true',
    QUEUE_REDIS_HOST: '127.0.0.1',
    QUEUE_REDIS_PORT: '1',
    QUEUE_REDIS_PASSWORD: '',
});

const { describe, it, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { CONTRACT_VERSION, QUEUES } = await import('#Libs/queue_contracts.js');
const { QueueUnavailableError, closeQueues, enqueue, pingQueueRedis } = await import('#Config/queue.js');

const ping = () => ({ v: CONTRACT_VERSION, sent_at: new Date().toISOString(), from: 'test' });

describe('Redis de colas no disponible', () => {
    after(async () => { await closeQueues(); });

    it('enqueue falla con QueueUnavailableError en ~2 s, sin colgarse', async () => {
        const started = Date.now();
        await assert.rejects(enqueue(QUEUES.SYSTEM, 'ping', ping()), QueueUnavailableError);
        assert.ok(Date.now() - started < 4_000, `tardo ${Date.now() - started} ms`);
    });

    it('pingQueueRedis respeta su tiempo maximo', async () => {
        const started = Date.now();
        await assert.rejects(pingQueueRedis(500));
        assert.ok(Date.now() - started < 2_000, `tardo ${Date.now() - started} ms`);
    });

    it('closeQueues termina rapido aunque Redis no este', async () => {
        const started = Date.now();
        await closeQueues();
        assert.ok(Date.now() - started < 2_000, `tardo ${Date.now() - started} ms`);
    });
});
