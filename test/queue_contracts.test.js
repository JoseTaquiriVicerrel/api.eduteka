import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    CONTRACT_VERSION, DEFAULT_JOB_OPTIONS, InvalidJobError, QUEUES, jobNames, queueNames, validateJob,
} from '#Libs/queue_contracts.js';
import { QueueDisabledError, closeQueues, createWorker, enqueue, getQueue, pingQueueRedis } from '#Config/queue.js';

const ping = (overrides = {}) => ({ v: CONTRACT_VERSION, sent_at: new Date().toISOString(), from: 'test', ...overrides });

describe('contrato de colas', () => {
    it('declara las colas y sus trabajos', () => {
        assert.deepEqual(queueNames(), ['system', 'simulacrum', 'simulacrum-grading']);
        assert.deepEqual(jobNames(QUEUES.SYSTEM), ['ping']);
        assert.deepEqual(jobNames(QUEUES.SIMULACRUM), ['milestone', 'reconcile', 'close-window']);
        assert.deepEqual(jobNames(QUEUES.SIMULACRUM_GRADING), ['grade-attempt']);
    });

    it('los nombres de cola no llevan ":" (BullMQ los rechaza)', () => {
        for (const name of queueNames()) assert.doesNotMatch(name, /:/);
    });

    it('hito: solo los cuatro tipos, con instante entero y id sin caracteres raros', () => {
        const milestone = (overrides) => ({ v: CONTRACT_VERSION, simulacrum_id: 'b2875ee8-1', kind: 'start', at: 1_800_000_000_000, ...overrides });
        assert.ok(validateJob(QUEUES.SIMULACRUM, 'milestone', milestone()));
        for (const kind of ['close', 'end', 'results']) assert.ok(validateJob(QUEUES.SIMULACRUM, 'milestone', milestone({ kind })));
        assert.throws(() => validateJob(QUEUES.SIMULACRUM, 'milestone', milestone({ kind: 'otro' })), InvalidJobError);
        assert.throws(() => validateJob(QUEUES.SIMULACRUM, 'milestone', milestone({ at: 1.5 })), InvalidJobError);
        assert.throws(() => validateJob(QUEUES.SIMULACRUM, 'milestone', milestone({ simulacrum_id: 'a:b' })), InvalidJobError);
        assert.throws(() => validateJob(QUEUES.SIMULACRUM, 'milestone', milestone({ simulacrum_id: { $ne: null } })), InvalidJobError);
    });

    it('calificacion: simulacro e intento', () => {
        const data = { v: CONTRACT_VERSION, simulacrum_id: 's1', user_simulacrum_id: 'u1' };
        assert.ok(validateJob(QUEUES.SIMULACRUM_GRADING, 'grade-attempt', data));
        assert.throws(() => validateJob(QUEUES.SIMULACRUM_GRADING, 'grade-attempt', { ...data, user_simulacrum_id: '' }), InvalidJobError);
    });

    it('acepta una carga valida y la devuelve tal cual', () => {
        const data = ping();
        assert.equal(validateJob(QUEUES.SYSTEM, 'ping', data), data);
    });

    it('rechaza un trabajo o una cola desconocidos', () => {
        assert.throws(() => validateJob(QUEUES.SYSTEM, 'nada', ping()), InvalidJobError);
        assert.throws(() => validateJob('otra', 'ping', ping()), InvalidJobError);
    });

    it('rechaza otra version del contrato, campos de mas y campos que faltan', () => {
        assert.throws(() => validateJob(QUEUES.SYSTEM, 'ping', ping({ v: 2 })), InvalidJobError);
        assert.throws(() => validateJob(QUEUES.SYSTEM, 'ping', ping({ extra: true })), InvalidJobError);
        const { from: _omit, ...missing } = ping();
        assert.throws(() => validateJob(QUEUES.SYSTEM, 'ping', missing), InvalidJobError);
    });

    it('explica que falla en `details`', () => {
        try {
            validateJob(QUEUES.SYSTEM, 'ping', ping({ v: 2 }));
            assert.fail('debia lanzar');
        } catch (error) {
            assert.ok(error instanceof InvalidJobError);
            assert.ok(error.details.length > 0);
            assert.match(error.details.join(' '), /\/v/);
        }
    });

    it('reintenta con espera exponencial y limpia lo terminado', () => {
        assert.equal(DEFAULT_JOB_OPTIONS.attempts, 3);
        assert.equal(DEFAULT_JOB_OPTIONS.backoff.type, 'exponential');
        assert.ok(DEFAULT_JOB_OPTIONS.removeOnComplete.age > 0);
        assert.ok(DEFAULT_JOB_OPTIONS.removeOnFail.age >= DEFAULT_JOB_OPTIONS.removeOnComplete.age);
    });
});

describe('colas apagadas (QUEUE_ENABLED=false, el valor por defecto)', () => {
    it('enqueue valida primero y despues avisa que las colas estan apagadas, sin tocar Redis', async () => {
        await assert.rejects(enqueue(QUEUES.SYSTEM, 'ping', ping({ v: 9 })), InvalidJobError);
        await assert.rejects(enqueue(QUEUES.SYSTEM, 'ping', ping()), QueueDisabledError);
    });

    it('getQueue, createWorker y pingQueueRedis tambien se niegan', async () => {
        assert.throws(() => getQueue(QUEUES.SYSTEM), QueueDisabledError);
        assert.throws(() => createWorker(QUEUES.SYSTEM, {}), QueueDisabledError);
        await assert.rejects(pingQueueRedis(), QueueDisabledError);
    });

    it('closeQueues no falla aunque nada se haya abierto', async () => {
        await closeQueues();
        await closeQueues();
    });
});
