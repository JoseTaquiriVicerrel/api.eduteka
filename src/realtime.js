import http from 'node:http';
import mongoose from 'mongoose';
import redisClient from '#Config/redis.js';
import { settings } from '#Config/settings.js';
import { logger } from '#Libs/logger.js';
import { healthHandler } from '#Libs/process_health.js';
import { closeBus } from '#Modules/simulacra/realtime/simulacrum.events.js';
import { attachRealtime } from '#Modules/simulacra/realtime/simulacrum.realtime.js';
import { runProcess } from './bootstrap.js';

// edk-realtime: el unico servidor socket.io de los simulacros en vivo (plan de separacion de
// servicios, Fase 1). Sirve a la app (Bearer), a la web Next (Bearer via BFF) y a las paginas SSR
// del monolito (cookie `session`, validada en el monolito). Solo retransmite: escucha el bus
// `edk:simulacrum:events`, relee Mongo y emite a la sala.
//
// Varias replicas: cada una recibe todas las senales del bus y emite a SUS sockets, asi que no hace
// falta adapter. Con transporte polling, Nginx tiene que mandar a cada cliente siempre a la misma
// replica (ip_hash); con websocket no.
//
//   GET  /health                      Mongo + Redis real (el bus no funciona con el cliente en memoria)
//   WS   ${REALTIME_PATH}/            socket.io

runProcess('realtime', async () => {
    const health = healthHandler({
        name: 'realtime',
        checks: {
            mongo: async () => mongoose.connection.readyState === 1,
            redis: async () => !redisClient.isMemoryFallback && (await redisClient.ping()) === 'PONG',
        },
    });

    const server = http.createServer((req, res) => {
        // socket.io atiende su propia ruta (se registra antes que este manejador); lo demas es /health.
        if (req.url === '/health') {
            void health(req, res);
            return;
        }
        if (!req.url?.startsWith(settings.realtime.path)) res.writeHead(404).end();
    });

    const io = attachRealtime(server);

    await new Promise((resolve) => {
        const listen = settings.listenHost
            ? () => server.listen(settings.realtime.port, settings.listenHost, resolve)
            : () => server.listen(settings.realtime.port, resolve);
        listen();
    });
    logger.info({ port: settings.realtime.port, path: settings.realtime.path, cookieAuth: Boolean(settings.realtime.cookieAuth && settings.webClient.monolithUrl) }, 'Realtime escuchando');

    return async () => {
        // `io.close()` cierra tambien el servidor HTTP y desconecta a los sockets.
        await new Promise((done) => io.close(() => done()));
        await closeBus();
    };
}, { requireRedis: true });
