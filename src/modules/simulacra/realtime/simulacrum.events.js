// Bus de senales de los simulacros programados (contrato §7.1).
//
// El monolito es dueño de los temporizadores: cuando vence un hito (cierra la inscripcion, empieza,
// termina, se publican resultados) escribe en Mongo y publica una SENAL en Redis. La senal no lleva
// datos de negocio, solo "paso X en el simulacro Y"; quien la recibe lee la verdad de la base.
//
//   canal:   edk:simulacrum:events
//   mensaje: { v: 1, type, simulacrum_id, slug, emitted_at }
//
// Produccion: una conexion Redis APARTE en modo suscriptor (una conexion suscrita no puede hacer otros
// comandos). Sin Redis (cliente en memoria, desarrollo y pruebas): un EventEmitter local; en ese modo el
// monolito no puede avisar a la API y los clientes caen al modo degradado de contrato §7.3.
//
// Nunca lanza: un mensaje corrupto se registra y se ignora.

import { EventEmitter } from 'node:events';
import redisClient from '#Config/redis.js';
import { logger } from '#Libs/logger.js';

export const SIGNAL_CHANNEL = 'edk:simulacrum:events';
export const SIGNAL_VERSION = 1;
export const SIGNAL_TYPES = Object.freeze(['close', 'start', 'end', 'results', 'updated']);

const bus = new EventEmitter();
bus.setMaxListeners(0);

let subscriber = null;
let starting = null;
let warnedMemory = false;

/** Valida una senal ya parseada. Devuelve el mensaje normalizado o null. */
export const normalizeSignal = (message) => {
    if (!message || typeof message !== 'object') return null;
    if (message.v !== SIGNAL_VERSION) return null;
    if (!SIGNAL_TYPES.includes(message.type)) return null;
    if (typeof message.simulacrum_id !== 'string' || !message.simulacrum_id) return null;
    return {
        v: SIGNAL_VERSION,
        type: message.type,
        simulacrum_id: message.simulacrum_id,
        slug: typeof message.slug === 'string' ? message.slug : null,
        emitted_at: typeof message.emitted_at === 'string' ? message.emitted_at : null,
    };
};

/** Parsea el texto que llega por Redis. Devuelve la senal o null (se registra, no se lanza). */
export const parseSignal = (raw) => {
    try {
        const signal = normalizeSignal(JSON.parse(raw));
        if (!signal) logger.warn({ raw: String(raw).slice(0, 200) }, 'Senal de simulacro descartada');
        return signal;
    } catch {
        logger.warn({ raw: String(raw).slice(0, 200) }, 'Senal de simulacro ilegible');
        return null;
    }
};

const startSubscriber = async () => {
    if (redisClient.isMemoryFallback || typeof redisClient.duplicate !== 'function') {
        if (!warnedMemory) {
            warnedMemory = true;
            logger.warn('Sin Redis: la API no recibira avisos del monolito; los clientes consultan la ficha cada 30 s');
        }
        return;
    }
    if (subscriber) return;

    const connection = redisClient.duplicate();
    connection.on('error', (error) => logger.error({ err: error?.message }, 'Redis (suscriptor de simulacros)'));
    // node-redis vuelve a suscribirse solo al reconectar; lo perdido en el corte se recupera con un estado nuevo.
    let everReady = false;
    connection.on('ready', () => {
        if (everReady) bus.emit('resync');
        everReady = true;
    });

    await connection.connect();
    await connection.subscribe(SIGNAL_CHANNEL, (raw) => {
        const signal = parseSignal(raw);
        if (signal) bus.emit('signal', signal);
    });
    subscriber = connection;
};

/**
 * Se suscribe a las senales. `handler(signal)` (puede ser async: sus errores no tumban el bus).
 * Devuelve la funcion para cancelar. La conexion Redis se abre la primera vez.
 */
export const subscribe = (handler) => {
    const wrapped = (signal) => {
        Promise.resolve()
            .then(() => handler(signal))
            .catch((error) => logger.error({ err: error?.message }, 'Error al atender una senal de simulacro'));
    };
    bus.on('signal', wrapped);
    starting ??= startSubscriber().catch((error) => {
        starting = null;
        logger.error({ err: error?.message }, 'No se pudo suscribir a las senales de simulacros');
    });
    return () => bus.off('signal', wrapped);
};

/** Se llama tras reconectar a Redis: hay que reenviar el estado de las salas activas. */
export const onResync = (handler) => {
    const wrapped = () => {
        Promise.resolve()
            .then(handler)
            .catch((error) => logger.error({ err: error?.message }, 'Error al reenviar el estado de simulacros'));
    };
    bus.on('resync', wrapped);
    return () => bus.off('resync', wrapped);
};

/** Inyecta una senal en el bus local (pruebas y modo memoria). Ignora lo que no cumpla el contrato. */
export const publishLocal = (message) => {
    const signal = normalizeSignal(message);
    if (!signal) {
        logger.warn('Senal local de simulacro descartada');
        return false;
    }
    bus.emit('signal', signal);
    return true;
};

/** Cierra la conexion de suscripcion (apagado ordenado). */
export const closeBus = async () => {
    const connection = subscriber;
    subscriber = null;
    starting = null;
    bus.removeAllListeners();
    if (connection) await connection.quit().catch(() => {});
};
