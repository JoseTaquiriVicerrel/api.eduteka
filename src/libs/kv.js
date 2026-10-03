import redisClient from '#Config/redis.js';
import { logger } from '#Libs/logger.js';

// Almacen clave-valor efimero de la API (rate limit, enfriamientos de codigos,
// contadores de fallos). Usa el mismo Redis que el monolito, con el prefijo
// `api:` para no pisar sus claves (sesiones, `exams:*`).
//
// #Config/redis.js degrada a un cliente en memoria que a proposito NO implementa
// `incr` (ver su cabecera), asi que aqui el contador tiene su propia tabla en
// memoria. Lo mismo ocurre si Redis se cae con la app en marcha: la operacion
// que falla se atiende en memoria en vez de tumbar la peticion.

const PREFIX = 'api:';
const memory = new Map(); // clave -> { value, expiresAt }

const usingRedis = () => !redisClient.isMemoryFallback;

const memRead = (key) => {
    const entry = memory.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        memory.delete(key);
        return undefined;
    }
    return entry;
};

const memTtl = (key) => {
    const entry = memRead(key);
    return entry ? Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000)) : 0;
};

// Ejecuta la version Redis y, si falla, la de memoria.
const run = async (redisOp, memoryOp) => {
    if (usingRedis()) {
        try {
            return await redisOp();
        } catch (error) {
            logger.warn({ err: error.message }, 'Redis fallo; usando memoria para esta operacion');
        }
    }
    return memoryOp();
};

/**
 * Contador de ventana fija. Devuelve el conteo tras sumar `amount` (1 por
 * defecto) y los segundos que le quedan a la ventana.
 */
export const incrWindow = (key, windowSeconds, amount = 1) => run(
    async () => {
        const redisKey = PREFIX + key;
        const count = await redisClient.incrBy(redisKey, amount);
        let ttl = await redisClient.ttl(redisKey);
        // Autocorreccion: una clave sin caducidad (INCR y EXPIRE no son atomicos)
        // bloquearia a ese cliente para siempre.
        if (count === amount || ttl < 0) {
            await redisClient.expire(redisKey, windowSeconds);
            ttl = windowSeconds;
        }
        return { count, ttl };
    },
    () => {
        const entry = memRead(key);
        if (!entry) {
            memory.set(key, { value: amount, expiresAt: Date.now() + windowSeconds * 1000 });
            return { count: amount, ttl: windowSeconds };
        }
        entry.value += amount;
        return { count: entry.value, ttl: memTtl(key) };
    },
);

/** Lee el contador sin sumar. */
export const peekWindow = (key) => run(
    async () => {
        const redisKey = PREFIX + key;
        const [raw, ttl] = await Promise.all([redisClient.get(redisKey), redisClient.ttl(redisKey)]);
        return { count: Number(raw ?? 0), ttl: ttl > 0 ? ttl : 0 };
    },
    () => {
        const entry = memRead(key);
        return { count: entry ? entry.value : 0, ttl: memTtl(key) };
    },
);

/**
 * Toma la clave solo si no existia. Devuelve true si la tomo. Sirve de
 * enfriamiento: el primero que llega pasa, el resto espera `ttlSeconds`.
 */
export const setNX = (key, ttlSeconds) => run(
    async () => (await redisClient.set(PREFIX + key, '1', { expiration: { type: 'EX', value: ttlSeconds }, condition: 'NX' })) === 'OK',
    () => {
        if (memRead(key)) return false;
        memory.set(key, { value: 1, expiresAt: Date.now() + ttlSeconds * 1000 });
        return true;
    },
);

export const ttl = (key) => run(
    async () => Math.max(0, await redisClient.ttl(PREFIX + key)),
    () => memTtl(key),
);

export const del = (key) => run(
    async () => { await redisClient.del(PREFIX + key); },
    () => { memory.delete(key); },
);

/** Valor JSON con caducidad (cache). null si no existe o venció. */
export const getJson = (key) => run(
    async () => {
        const raw = await redisClient.get(PREFIX + key);
        return raw ? JSON.parse(raw) : null;
    },
    () => {
        const entry = memRead(key);
        return entry ? entry.value : null;
    },
);

export const setJson = (key, value, ttlSeconds) => run(
    async () => { await redisClient.set(PREFIX + key, JSON.stringify(value), { expiration: { type: 'EX', value: ttlSeconds } }); },
    () => { memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 }); },
);

/** Solo para tests: vacia la tabla en memoria. */
export const flushMemory = () => memory.clear();

export default { incrWindow, peekWindow, setNX, ttl, del, getJson, setJson, flushMemory };
