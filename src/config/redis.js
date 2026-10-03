// Carga el .env ANTES de conectar: este modulo conecta al importarse (top-level
// await) y server.js lo importa antes que settings.js. Sin esto, REDIS_HOST y
// REDIS_PORT aun no existen y cae a localhost:6379 -> cliente en memoria.
import '#Config/env.js';
import { createClient } from "redis";

// Este modulo se resuelve con top-level await, asi que TODO lo que importe la
// app (directa o transitivamente) espera aqui. La version anterior hacia
// `await client.connect()` sin limite: con Redis caido el import no fallaba,
// se colgaba para siempre reintentando, y el proceso nunca llegaba a arrancar.
// Ahora el arranque esta acotado y, si no hay Redis, se degrada a un cliente
// en memoria en vez de bloquear.

const CONNECT_TIMEOUT_MS = Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 5000);
const STARTUP_MAX_RETRIES = Number(process.env.REDIS_STARTUP_MAX_RETRIES ?? 3);
const STARTUP_DEADLINE_MS = Number(process.env.REDIS_STARTUP_DEADLINE_MS ?? 15000);

// --------------------------------------------------------------------------
// Cliente en memoria (fallback)
// --------------------------------------------------------------------------
// Implementa solo los comandos que la app usa de verdad, con la misma
// semantica de retorno que node-redis. Deliberadamente NO implementa los que
// nadie llama: un metodo ausente revienta con un TypeError visible, mientras
// que un stub que devuelve 'OK' sin hacer nada corrompe datos en silencio.
//
// Excepcion consciente: `incr` tampoco esta, y ademas #Middlewares/api/rate_limit.js
// usa justo `typeof redisClient.incr !== 'function'` para detectar este cliente
// y contar con su propia ventana en memoria. Si algun dia se añade `incr` aqui,
// hay que revisar ese guardia.

const createMemoryClient = () => {
  // key -> { value, expiresAt (ms epoch | null), kind: 'string' | 'json' }
  const store = new Map();

  const read = (key) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  // Acepta las dos formas que convivien en el codigo: `{ EX: n }` (lo que usan
  // token.service.js y exam.service.js) y `{ expiration: { type, value } }`
  // (lo que manda connect-redis v10).
  const expiresAtFrom = (options) => {
    if (!options || typeof options !== 'object') return null;
    if (options.KEEPTTL) return undefined; // conserva el TTL actual
    const spec = options.expiration ?? options;
    const type = options.expiration ? spec.type : null;
    const now = Date.now();

    if (type === 'EX' || typeof spec.EX === 'number') return now + Number(type ? spec.value : spec.EX) * 1000;
    if (type === 'PX' || typeof spec.PX === 'number') return now + Number(type ? spec.value : spec.PX);
    if (type === 'EXAT' || typeof spec.EXAT === 'number') return Number(type ? spec.value : spec.EXAT) * 1000;
    if (type === 'PXAT' || typeof spec.PXAT === 'number') return Number(type ? spec.value : spec.PXAT);
    return null;
  };

  const write = (key, value, kind, options) => {
    const previous = read(key);
    const expiresAt = expiresAtFrom(options);
    store.set(key, {
      value,
      kind,
      expiresAt: expiresAt === undefined ? (previous?.expiresAt ?? null) : expiresAt,
    });
    return 'OK';
  };

  const asKeyList = (keys) => (Array.isArray(keys) ? keys : [keys]);

  // Glob de Redis (`*`, `?`) -> RegExp. Se escapa todo y luego se reabren solo
  // los dos comodines; el `pattern.replace('*', '.*')` anterior solo convertia
  // la primera aparicion y dejaba escapar el resto.
  const globToRegExp = (pattern) => {
    const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$');
  };

  const liveKeys = () => [...store.keys()].filter((k) => read(k) !== undefined);

  const client = {
    isOpen: true,
    isMemoryFallback: true,

    connect: async () => client,
    quit: async () => 'OK',
    destroy: () => {},
    on: () => client,

    // El health check de /api/v1 hace `(await ping()) === 'PONG'`. Fallar aqui
    // es lo correcto: no hay Redis, y el endpoint debe reportar `degraded`.
    ping: async () => {
      throw new Error('Redis no disponible: la app corre con el cliente en memoria');
    },

    get: async (key) => {
      const entry = read(key);
      return entry === undefined ? null : entry.value;
    },

    set: async (key, value, options) => write(key, value, 'string', options),

    mGet: async (keys) => asKeyList(keys).map((k) => {
      const entry = read(k);
      return entry === undefined ? null : entry.value;
    }),

    del: async (keys) => asKeyList(keys).reduce((n, k) => (store.delete(k) ? n + 1 : n), 0),

    exists: async (keys) => asKeyList(keys).reduce((n, k) => (read(k) !== undefined ? n + 1 : n), 0),

    keys: async (pattern) => {
      const re = globToRegExp(pattern);
      return liveKeys().filter((k) => re.test(k));
    },

    expire: async (key, seconds) => {
      const entry = read(key);
      if (entry === undefined) return 0;
      entry.expiresAt = Date.now() + Number(seconds) * 1000;
      return 1;
    },

    ttl: async (key) => {
      const entry = read(key);
      if (entry === undefined) return -2;          // la clave no existe
      if (entry.expiresAt === null) return -1;     // existe y no caduca
      return Math.ceil((entry.expiresAt - Date.now()) / 1000);
    },

    // connect-redis lo usa para clear()/length()/ids()/all(). En node-redis v5
    // el iterador entrega LOTES de claves, no claves sueltas.
    scanIterator: async function* ({ MATCH = '*', COUNT = 100 } = {}) {
      const re = globToRegExp(MATCH);
      const matches = liveKeys().filter((k) => re.test(k));
      for (let i = 0; i < matches.length; i += COUNT) yield matches.slice(i, i + COUNT);
    },

    // RedisJSON, usado por exam.service.js para cachear examenes y stats.
    json: {
      get: async (key) => {
        const entry = read(key);
        return entry === undefined ? null : entry.value;
      },
      set: async (key, _path, value, options) => write(key, value, 'json', options),
    },
  };

  return client;
};

// --------------------------------------------------------------------------
// Cliente real
// --------------------------------------------------------------------------

const connectRealClient = async () => {
  // Se marca en cuanto la conexion funciona una vez. Distingue "Redis no
  // arranca" (abortamos rapido y caemos al fallback) de "Redis se cayo con la
  // app en marcha" (ahi hay que reintentar indefinidamente, como antes).
  let everConnected = false;
  let lastErrorMessage = null;

  const client = createClient({
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    socket: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => {
        if (!everConnected && retries >= STARTUP_MAX_RETRIES) {
          return new Error('Redis no respondio en el arranque');
        }
        return Math.min(2 ** retries * 100, 3000);
      },
    },
  });

  // node-redis emite 'error' de forma asincrona; sin listener, Node tumba el
  // proceso con un unhandled 'error' event. Se colapsan los mensajes repetidos
  // porque un Redis caido emite uno por reintento.
  client.on('error', (err) => {
    const message = err?.message ?? String(err);
    if (message === lastErrorMessage) return;
    lastErrorMessage = message;
    console.error('Redis Error:', message);
  });

  client.on('ready', () => {
    everConnected = true;
    lastErrorMessage = null;
    console.log('Redis connected');
  });

  client.on('end', () => console.log('Redis connection closed'));

  // Techo duro por si el socket se queda colgado sin emitir error ni resolver
  // (el caso que dejaba el import bloqueado indefinidamente).
  let deadline;
  const startupDeadline = new Promise((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error(`Redis no conecto en ${STARTUP_DEADLINE_MS} ms`)),
      STARTUP_DEADLINE_MS
    );
  });

  try {
    await Promise.race([client.connect(), startupDeadline]);
    return client;
  } catch (err) {
    // Si nos rendimos, hay que soltar el cliente fallido: si no, se queda con
    // el socket y el temporizador de reintento vivos, reintentando por detras
    // de un fallback que ya nadie mira e impidiendo que el proceso termine.
    try { client.destroy(); } catch { /* ya estaba cerrado */ }
    throw err;
  } finally {
    clearTimeout(deadline);
  }
};

let redisClient;
let usingMemoryFallback = false;

try {
  redisClient = await connectRealClient();
} catch (err) {
  usingMemoryFallback = true;
  redisClient = createMemoryClient();

  const detail = err?.message ?? String(err);
  if (process.env.MODE === 'PRODUCTION') {
    // En produccion esto es grave: las sesiones dejan de compartirse entre
    // instancias y se pierden al reiniciar. La app sigue en pie a proposito
    // (mejor degradada que caida), pero tiene que verse en los logs.
    console.error('='.repeat(70));
    console.error('ALERTA: Redis no disponible en PRODUCCION -> cliente en memoria.');
    console.error('Sesiones no compartidas entre instancias y cache sin persistir.');
    console.error('Motivo:', detail);
    console.error('='.repeat(70));
  } else {
    console.warn(`Redis no disponible (${detail}); usando cliente en memoria.`);
  }
}

export default redisClient;
export { usingMemoryFallback };
