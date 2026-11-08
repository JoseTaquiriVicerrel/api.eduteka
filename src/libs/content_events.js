// Senales de contenido del monolito (docs/spec-formulas-svg-al-publicar.md §3.2).
//
// Cuando un examen o simulacro se verifica (o cambia estando verificado) el monolito publica una senal
// en Redis. No lleva datos de negocio: solo "este contenido cambio"; quien la recibe lee la verdad de la base.
//
//   canal:   edk:content:events
//   mensaje: { v: 1, type: 'content', kind: 'exam'|'simulacrum', id, slug?, emitted_at }
//
// Misma politica que simulacrum.events.js: conexion Redis APARTE en modo suscriptor, EventEmitter local
// sin Redis (desarrollo y pruebas) y nunca lanza: un mensaje corrupto se registra y se ignora.

import { EventEmitter } from 'node:events';
import redisClient from '#Config/redis.js';
import { logger } from '#Libs/logger.js';

export const CONTENT_CHANNEL = 'edk:content:events';
export const CONTENT_VERSION = 1;
export const CONTENT_KINDS = Object.freeze(['exam', 'simulacrum']);

const bus = new EventEmitter();
bus.setMaxListeners(0);

let subscriber = null;
let starting = null;

/** Valida una senal ya parseada. Devuelve el mensaje normalizado o null. */
export const normalizeContentSignal = (message) => {
    if (!message || typeof message !== 'object') return null;
    if (message.v !== CONTENT_VERSION || message.type !== 'content') return null;
    if (!CONTENT_KINDS.includes(message.kind)) return null;
    if (typeof message.id !== 'string' || !message.id) return null;
    return {
        v: CONTENT_VERSION,
        type: 'content',
        kind: message.kind,
        id: message.id,
        slug: typeof message.slug === 'string' && message.slug ? message.slug : null,
        emitted_at: typeof message.emitted_at === 'string' ? message.emitted_at : null,
    };
};

export const parseContentSignal = (raw) => {
    try {
        const signal = normalizeContentSignal(JSON.parse(raw));
        if (!signal) logger.warn({ raw: String(raw).slice(0, 200) }, 'Senal de contenido descartada');
        return signal;
    } catch {
        logger.warn({ raw: String(raw).slice(0, 200) }, 'Senal de contenido ilegible');
        return null;
    }
};

const startSubscriber = async () => {
    if (redisClient.isMemoryFallback || typeof redisClient.duplicate !== 'function') {
        logger.warn('Sin Redis: la API no recibira avisos de contenido; las formulas se convierten al vuelo y con la tarea programada');
        return;
    }
    if (subscriber) return;

    const connection = redisClient.duplicate();
    connection.on('error', (error) => logger.error({ err: error?.message }, 'Redis (suscriptor de contenido)'));
    await connection.connect();
    await connection.subscribe(CONTENT_CHANNEL, (raw) => {
        const signal = parseContentSignal(raw);
        if (signal) bus.emit('content', signal);
    });
    subscriber = connection;
};

/** `handler(signal)` puede ser async: sus errores no tumban el bus. Devuelve la funcion para cancelar. */
export const subscribeContent = (handler) => {
    const wrapped = (signal) => {
        Promise.resolve()
            .then(() => handler(signal))
            .catch((error) => logger.error({ err: error?.message }, 'Error al atender una senal de contenido'));
    };
    bus.on('content', wrapped);
    starting ??= startSubscriber().catch((error) => {
        starting = null;
        logger.error({ err: error?.message }, 'No se pudo suscribir a las senales de contenido');
    });
    return () => bus.off('content', wrapped);
};

/** Inyecta una senal en el bus local (pruebas y modo memoria). Ignora lo que no cumpla el contrato. */
export const publishContentLocal = (message) => {
    const signal = normalizeContentSignal(message);
    if (!signal) return false;
    bus.emit('content', signal);
    return true;
};

export const closeContentBus = async () => {
    const connection = subscriber;
    subscriber = null;
    starting = null;
    bus.removeAllListeners();
    if (connection) await connection.quit().catch(() => {});
};
