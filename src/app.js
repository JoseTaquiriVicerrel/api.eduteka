import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { settings } from '#Config/settings.js';
import { logger } from '#Libs/logger.js';
import { errorHandler, notFound } from '#Middlewares/error_handler.js';
import requestId from '#Middlewares/request_id.js';
import { buildV1Router } from '#Modules/index.js';

// Crea la aplicacion Express SIN escuchar en ningun puerto, para poder montarla
// en las pruebas (supertest) sin abrir sockets. server.js la arranca.

const corsOptions = {
    // La app nativa no envia Origin: sin Origin se deja pasar. Un navegador solo
    // recibe cabeceras CORS si su origen esta en API_CORS_ORIGINS.
    origin(origin, callback) {
        callback(null, !origin || settings.corsOrigins.includes(origin));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-App-Version', 'X-Request-Id', 'X-Device-Name', 'X-Device-Platform'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Date'],
    maxAge: 600,
};

export function createApp() {
    const app = express();

    app.disable('x-powered-by');
    app.set('trust proxy', settings.trustProxy);

    app.use(requestId);
    app.use(pinoHttp({
        logger,
        genReqId: (req) => req.id,
        autoLogging: { ignore: (req) => req.url.endsWith('/health') },
        customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }));
    app.use(helmet());
    app.use(cors(corsOptions));
    app.use(compression());

    // Sin cache por defecto (especificacion §3). Los catalogos publicos podran
    // sobrescribirlo con ETag mas adelante.
    app.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    app.use('/api/v1', buildV1Router());

    app.use(notFound);
    app.use(errorHandler);

    return app;
}

export default createApp;
