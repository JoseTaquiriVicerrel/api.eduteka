// Colas de trabajo (BullMQ) sobre la instancia de Redis de COLAS (puerto 6380, `noeviction`),
// aparte de la de cache (#Config/redis.js). Ver deploy/redis-queue.conf y #Libs/queue_contracts.js.
//
//   import { enqueue } from '#Config/queue.js';
//   await enqueue(QUEUES.SYSTEM, 'ping', { v: 1, sent_at, from: 'api' });
//
//   const worker = createWorker(QUEUES.SYSTEM, { ping: async (job) => ... });
//
// Dos tipos de conexion, por lo que pide BullMQ:
//   - productores (Queue) en procesos HTTP: `enableOfflineQueue: false`, para que un Redis de colas
//     caido haga fallar el encolado al instante en vez de dejar la peticion colgada;
//   - consumidores (Worker, QueueEvents): `maxRetriesPerRequest: null`, para que esperen a que
//     Redis vuelva en vez de romperse.
//
// Nada se conecta al importar este modulo: solo al primer uso. Asi la API puede importarlo con las
// colas apagadas (QUEUE_ENABLED=false, el valor por defecto).

import { FlowProducer, Queue, QueueEvents, Worker, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { settings } from '#Config/settings.js';
import { logger } from '#Libs/logger.js';
import { DEFAULT_JOB_OPTIONS, InvalidJobError, validateJob } from '#Libs/queue_contracts.js';

export class QueueDisabledError extends Error {
    constructor() {
        super('Las colas estan apagadas (QUEUE_ENABLED=false)');
        this.name = 'QueueDisabledError';
    }
}

export class QueueUnavailableError extends Error {
    constructor(detail) {
        super(`Redis de colas no disponible${detail ? `: ${detail}` : ''}`);
        this.name = 'QueueUnavailableError';
    }
}

// Cuanto espera un productor a que su conexion este lista antes de rendirse. Corto a proposito:
// quien encola suele estar atendiendo una peticion HTTP y no debe quedarse colgado.
const PRODUCER_READY_TIMEOUT_MS = 2_000;

const queues = new Map();
const workers = new Set();
const events = new Map();
const connections = new Set();
let flowProducer = null;

const baseOptions = () => ({
    host: settings.queue.host,
    port: settings.queue.port,
    username: settings.queue.username ?? undefined,
    password: settings.queue.password ?? undefined,
    connectionName: `edk-${process.title || 'node'}-${process.pid}`,
});

const openConnection = (role, extra) => {
    const connection = new Redis({ ...baseOptions(), ...extra });
    // Sin listener, ioredis emite 'error' sin capturar y tumba el proceso. Se colapsan repetidos.
    let lastError = null;
    connection.on('error', (error) => {
        if (error?.message === lastError) return;
        lastError = error?.message;
        logger.error({ err: error?.message, role }, 'Redis de colas: error de conexion');
    });
    connection.on('ready', () => { lastError = null; });
    connections.add(connection);
    return connection;
};

/**
 * Registrador de errores que colapsa repetidos: con Redis caido, BullMQ emite el mismo error en
 * cada reintento (varias veces por segundo) y llenaria el log. Se escribe el primero y, de nuevo,
 * cuando cambia el mensaje o pasa un minuto.
 */
const collapsedErrorLogger = (message, fields) => {
    let last = null;
    let lastAt = 0;
    return (error) => {
        const text = error?.message ?? String(error);
        if (text === last && Date.now() - lastAt < 60_000) return;
        last = text;
        lastAt = Date.now();
        logger.error({ err: text, ...fields }, message);
    };
};

let producerConnection = null;
const producer = () => {
    producerConnection ??= openConnection('producer', { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    return producerConnection;
};

/**
 * Espera (acotado) a que la conexion de productor este lista. Con `enableOfflineQueue: false`
 * un comando enviado mientras conecta (o reconecta) falla con "Stream isn't writeable": aqui se
 * espera a 'ready' hasta `timeoutMs` y, si no llega, se lanza QueueUnavailableError.
 */
const producerReady = (timeoutMs = PRODUCER_READY_TIMEOUT_MS) => {
    const connection = producer();
    if (connection.status === 'ready') return Promise.resolve(connection);
    return new Promise((resolve, reject) => {
        const done = (error) => {
            clearTimeout(timer);
            connection.off('ready', onReady);
            if (error) reject(error);
            else resolve(connection);
        };
        const onReady = () => done();
        const timer = setTimeout(
            () => done(new QueueUnavailableError(`sin conexion tras ${timeoutMs} ms (estado: ${connection.status})`)),
            timeoutMs,
        );
        connection.on('ready', onReady);
    });
};

const consumer = () => openConnection('consumer', { maxRetriesPerRequest: null });

const assertEnabled = () => {
    if (!settings.queue.enabled) throw new QueueDisabledError();
};

export const getQueue = (name) => {
    assertEnabled();
    let queue = queues.get(name);
    if (!queue) {
        queue = new Queue(name, {
            connection: producer(),
            prefix: settings.queue.prefix,
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
        });
        queue.on('error', collapsedErrorLogger('Error de cola', { queue: name }));
        queues.set(name, queue);
    }
    return queue;
};

/**
 * Valida contra el contrato y encola. Lanza QueueDisabledError o InvalidJobError antes de tocar
 * Redis, y QueueUnavailableError en ~2 s si el Redis de colas no responde (nunca deja colgado al
 * que llama).
 */
export const enqueue = async (queue, name, data, options = {}) => {
    validateJob(queue, name, data);
    const target = getQueue(queue);
    await producerReady();
    return target.add(name, data, options);
};

/**
 * Flujos padre/hijos (el cierre de una ventana: un padre que corre cuando terminaron las
 * calificaciones). Solo procesos de fondo: usa una conexion que espera a Redis.
 * Valida contra el contrato el padre y cada hijo antes de tocar Redis.
 */
export const addFlow = async (flow) => {
    assertEnabled();
    const check = (node) => {
        validateJob(node.queueName, node.name, node.data);
        (node.children ?? []).forEach(check);
    };
    check(flow);
    flowProducer ??= new FlowProducer({ connection: consumer(), prefix: settings.queue.prefix });
    const withDefaults = (node) => ({
        ...node,
        opts: { ...DEFAULT_JOB_OPTIONS, ...node.opts },
        ...(node.children ? { children: node.children.map(withDefaults) } : {}),
    });
    return flowProducer.add(withDefaults(flow));
};

/**
 * Consumidor de una cola. `handlers` es { nombreDeTrabajo: async (job, token) => resultado }
 * (`token` sirve para re-diferir el trabajo con `job.moveToDelayed`).
 * La carga util se valida antes de procesar: una invalida falla con UnrecoverableError (no se
 * reintenta: repetirla daria el mismo error).
 */
export const createWorker = (queue, handlers, { concurrency = settings.worker.concurrency } = {}) => {
    assertEnabled();
    const worker = new Worker(queue, async (job, token) => {
        const handler = handlers[job.name];
        if (!handler) throw new UnrecoverableError(`Sin manejador para ${queue}/${job.name}`);
        try {
            validateJob(queue, job.name, job.data);
        } catch (error) {
            if (error instanceof InvalidJobError) {
                throw new UnrecoverableError(`${error.message}: ${error.details.join('; ')}`);
            }
            throw error;
        }
        return handler(job, token);
    }, {
        connection: consumer(),
        prefix: settings.queue.prefix,
        concurrency,
    });

    worker.on('failed', (job, error) => {
        logger.error({ err: error?.message, queue, job: job?.name, id: job?.id, attempt: job?.attemptsMade }, 'Trabajo fallido');
    });
    worker.on('error', collapsedErrorLogger('Error del worker', { queue }));
    workers.add(worker);
    return worker;
};

/** Eventos de una cola (para esperar el resultado de un trabajo con `job.waitUntilFinished`). */
export const getQueueEvents = (name) => {
    assertEnabled();
    let queueEvents = events.get(name);
    if (!queueEvents) {
        queueEvents = new QueueEvents(name, { connection: consumer(), prefix: settings.queue.prefix });
        queueEvents.on('error', collapsedErrorLogger('Error de eventos de cola', { queue: name }));
        events.set(name, queueEvents);
    }
    return queueEvents;
};

/** PING al Redis de colas con tiempo maximo. Lo usan /health de los procesos de fondo y el arranque. */
export const pingQueueRedis = async (timeoutMs = 2_000) => {
    assertEnabled();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Redis de colas no respondio en ${timeoutMs} ms`)), timeoutMs);
    });
    try {
        return await Promise.race([producerReady(timeoutMs).then((connection) => connection.ping()), timeout]);
    } finally {
        clearTimeout(timer);
    }
};

// Tope para cerrar cada pieza. Con el Redis de colas caido, `close()`/`quit()` esperarian a una
// conexion que no vuelve y el apagado se colgaria hasta el cierre forzado de bootstrap.
const CLOSE_TIMEOUT_MS = 5_000;
const closeWithin = (promise) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
};

/**
 * Cierra workers (esperando los trabajos en curso, con tope), eventos, colas y conexiones.
 * Idempotente. Una conexion que no esta lista se corta (`disconnect`) en vez de esperar su QUIT.
 */
export const closeQueues = async () => {
    const all = [...workers, ...events.values(), ...queues.values(), ...(flowProducer ? [flowProducer] : [])];
    workers.clear();
    events.clear();
    queues.clear();
    flowProducer = null;

    const open = [...connections];
    connections.clear();
    producerConnection = null;

    const redisDown = open.some((connection) => connection.status !== 'ready');
    // Sin Redis no hay trabajos en curso que esperar: se corta primero para que close() no se cuelgue.
    if (redisDown) open.forEach((connection) => connection.disconnect());

    await Promise.allSettled(all.map((item) => closeWithin(item.close())));
    await Promise.allSettled(open.map((connection) => (connection.status === 'ready'
        ? closeWithin(connection.quit())
        : Promise.resolve(connection.disconnect()))));
};
