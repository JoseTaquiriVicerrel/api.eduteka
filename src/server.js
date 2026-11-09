import { settings } from '#Config/settings.js';
import { createApp } from './app.js';
import { logger } from '#Libs/logger.js';
import { closeBus } from '#Modules/simulacra/realtime/simulacrum.events.js';
import { closeContentBus } from '#Libs/content_events.js';
import { startMathPrewarm } from '#Libs/math_prewarm.js';
import { attachRealtime } from '#Modules/simulacra/realtime/simulacrum.realtime.js';
import { runProcess } from './bootstrap.js';

// Punto de entrada de la API JSON: levanta HTTP (y, mientras no corra aparte, el socket de los
// simulacros). La conexion a Mongo y el apagado ordenado viven en ./bootstrap.js.

runProcess('api', async () => {
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

    return async () => {
        // `io.close()` cierra tambien el servidor HTTP y desconecta a los sockets (si no, el cierre se cuelga).
        await new Promise((done) => (io ? io.close(() => done()) : server.close(() => done())));
        await closeBus();
        await closeContentBus();
    };
});
