import mongoose from 'mongoose';
import redisClient from '#Config/redis.js';
import { settings } from '#Config/settings.js';
import { logger } from '#Libs/logger.js';
import { closeQueues } from '#Config/queue.js';

// Arranque comun de todos los procesos del repositorio (API HTTP, worker y, en fases siguientes,
// realtime, scheduler y docs): conecta Mongo, ejecuta el arranque propio del proceso y se apaga en
// orden con SIGTERM/SIGINT. Cada punto de entrada solo describe lo suyo:
//
//   runProcess('worker', async () => {
//       const worker = createWorker(...);
//       return async () => worker.close();     // como se detiene (opcional)
//   }, { requireRedis: true });

// La API comparte la base con el monolito, que es el dueño de los indices. Si la
// API los creara al arrancar podria construir indices unicos sobre datos con
// duplicados (falla en silencio) o dejar al monolito con errores E11000. Las
// colecciones que son solo de la API (refreshtokens) piden `autoIndex: true` en
// su propio schema.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const SHUTDOWN_TIMEOUT_MS = 10_000;

let handlersInstalled = false;
const installProcessHandlers = () => {
    if (handlersInstalled) return;
    handlersInstalled = true;

    process.on('unhandledRejection', (reason) => {
        logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandledRejection');
    });

    // El proceso queda en estado indefinido tras una excepcion no capturada: se registra con
    // stack (para saber el motivo del crash) y se sale para que el supervisor lo reinicie.
    process.on('uncaughtException', (error, origin) => {
        logger.fatal({ err: error?.message ?? String(error), stack: error?.stack, origin }, 'uncaughtException');
        process.exit(1);
    });
};

export const connectMongo = async () => {
    await mongoose.connect(settings.mongoUri, { serverSelectionTimeoutMS: 10_000 });
    logger.info({ db: mongoose.connection.name }, 'MongoDB conectado');
};

/**
 * Arranca un proceso.
 *
 * @param {string} name                       nombre para los logs ('api', 'worker'...)
 * @param {() => Promise<(() => Promise<void>) | void>} start   arranque propio; puede devolver su `stop`
 * @param {{ requireRedis?: boolean, mongo?: boolean }} [options]
 *   requireRedis: el proceso no sirve con el cliente de Redis en memoria (un worker que no comparte
 *   estado con nadie). Sin Redis real termina con exit(1) y systemd lo reintenta.
 *   mongo: false para procesos que no usan la base (edk-docs).
 */
export function runProcess(name, start, { requireRedis = false, mongo = true } = {}) {
    installProcessHandlers();

    const boot = async () => {
        if (requireRedis && redisClient.isMemoryFallback) {
            throw new Error('Redis no disponible: este proceso no funciona con el cliente en memoria');
        }

        if (mongo) await connectMongo();
        const stop = await start();

        let closing = false;
        const shutdown = async (signal) => {
            if (closing) return;
            closing = true;
            logger.info({ signal, process: name }, 'Apagando');

            const force = setTimeout(() => {
                logger.error({ process: name }, 'Cierre forzado por tiempo agotado');
                process.exit(1);
            }, SHUTDOWN_TIMEOUT_MS);
            force.unref();

            try {
                if (typeof stop === 'function') await stop();
                await closeQueues();
                if (mongo) await mongoose.disconnect();
                if (!redisClient.isMemoryFallback) await redisClient.quit();
            } catch (error) {
                logger.error({ err: error.message, process: name }, 'Error al cerrar conexiones');
            }
            process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    };

    boot().catch((error) => {
        logger.fatal({ err: error.message, process: name }, `No se pudo iniciar el proceso ${name}`);
        process.exit(1);
    });
}
