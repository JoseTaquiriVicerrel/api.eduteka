// /health de los procesos de fondo (worker, scheduler): un servidor HTTP minimo en 127.0.0.1 que
// consultan deploy/release.sh y el monitor. 200 si todas las comprobaciones dan true; 503 si no.
//
//   const server = startHealthServer({ name: 'worker', port: 3003, checks: { mongo: async () => ..., queue: ... } });

import http from 'node:http';
import { logger } from '#Libs/logger.js';

// Responde el estado como JSON. Exportado para los procesos que ya tienen su propio servidor
// HTTP (edk-realtime monta /health en el mismo puerto que el socket).
export const healthHandler = ({ name, checks }) => async (req, res) => {
    const entries = await Promise.all(Object.entries(checks).map(async ([key, check]) => {
        try {
            return [key, (await check()) === true];
        } catch {
            return [key, false];
        }
    }));
    const results = Object.fromEntries(entries);
    const ok = entries.every(([, value]) => value);
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', process: name, ...results }));
};

export const startHealthServer = ({ name, port, checks }) => {
    const handle = healthHandler({ name, checks });
    const server = http.createServer((req, res) => {
        if (req.url !== '/health') {
            res.writeHead(404).end();
            return;
        }
        void handle(req, res);
    });
    server.listen(port, '127.0.0.1', () => logger.info({ port, process: name }, 'Salud escuchando'));
    return server;
};

export const closeServer = (server) => new Promise((done) => (server ? server.close(() => done()) : done()));
