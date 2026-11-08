import mongoose from 'mongoose';
import redisClient from '#Config/redis.js';
import { settings } from '#Config/settings.js';
import { createApp } from './app.js';
import { logger } from '#Libs/logger.js';
import { closeBus } from '#Modules/simulacra/realtime/simulacrum.events.js';
import { closeContentBus } from '#Libs/content_events.js';
import { startMathPrewarm } from '#Libs/math_prewarm.js';
import { attachRealtime } from '#Modules/simulacra/realtime/simulacrum.realtime.js';

// Punto de entrada de la API JSON: conecta Mongo, levanta HTTP y se apaga en orden.

// La API comparte la base con el monolito, que es el dueño de los indices. Si la
// API los creara al arrancar podria construir indices unicos sobre datos con
// duplicados (falla en silencio) o dejar al monolito con errores E11000. Las
// colecciones que son solo de la API (refreshtokens) piden `autoIndex: true` en
// su propio schema.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function bootstrap() {
    await mongoose.connect(settings.mongoUri, { serverSelectionTimeoutMS: 10_000 });
    logger.info({ db: mongoose.connection.name }, 'MongoDB conectado');

    // Los modelos propios de la API crean sus indices aqui, ya con la conexion abierta.
    const { default: RefreshTokenModel } = await import('#Models/refresh_token_model.js');
    await RefreshTokenModel.init();

    const onListening = () => logger.info({ host: settings.listenHost ?? 'todas', port: settings.port, env: settings.nodeEnv }, 'API escuchando');
    const server = settings.listenHost
        ? createApp().listen(settings.port, settings.listenHost, onListening)
        : createApp().listen(settings.port, onListening);

    // Tiempo real de los simulacros programados. `createApp()` no cambia: las pruebas con supertest no abren puertos.
    const io = settings.realtime.enabled ? attachRealtime(server) : null;

    if (settings.mathPrewarm.enabled) startMathPrewarm();

    let closing = false;
    const shutdown = async (signal) => {
        if (closing) return;
        closing = true;
        logger.info({ signal }, 'Apagando');

        const force = setTimeout(() => {
            logger.error('Cierre forzado por tiempo agotado');
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);
        force.unref();

        // `io.close()` cierra tambien el servidor HTTP y desconecta a los sockets (si no, el cierre se cuelga).
        const closeHttp = (done) => (io ? io.close(done) : server.close(done));
        closeHttp(async () => {
            try {
                await closeBus();
                await closeContentBus();
                await mongoose.disconnect();
                if (!redisClient.isMemoryFallback) await redisClient.quit();
            } catch (error) {
                logger.error({ err: error.message }, 'Error al cerrar conexiones');
            }
            process.exit(0);
        });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandledRejection');
});

// El proceso queda en estado indefinido tras una excepcion no capturada: se registra con
// stack (para saber el motivo del crash) y se sale para que el supervisor lo reinicie.
process.on('uncaughtException', (error, origin) => {
    logger.fatal({ err: error?.message ?? String(error), stack: error?.stack, origin }, 'uncaughtException');
    process.exit(1);
});

bootstrap().catch((error) => {
    logger.fatal({ err: error.message }, 'No se pudo iniciar la API');
    process.exit(1);
});
