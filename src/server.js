import mongoose from 'mongoose';
import redisClient from '#Config/redis.js';
import { settings } from '#Config/settings.js';
import { createApp } from './app.js';
import { logger } from '#Libs/logger.js';

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

    const server = createApp().listen(settings.port, () => {
        logger.info({ port: settings.port, env: settings.nodeEnv }, 'API escuchando');
    });

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

        server.close(async () => {
            try {
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
