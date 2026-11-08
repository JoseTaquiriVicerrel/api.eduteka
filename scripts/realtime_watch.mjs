// Escucha el socket de un simulacro programado e imprime cada evento con su desfase respecto al
// instante programado. Sirve para la prueba de punta a punta con el monolito (docs/prueba-e2e-simulacros-en-vivo.md).
//
//   node scripts/realtime_watch.mjs <url-de-la-api> <slug> <access_token>
//   ej.  node scripts/realtime_watch.mjs http://127.0.0.1:3000 mi-simulacro eyJhbGciOi...
//
// Requiere socket.io-client (devDependency): se ejecuta en una maquina de desarrollo, no en produccion.
import { io } from 'socket.io-client';

const [url, slug, token] = process.argv.slice(2);
if (!url || !slug || !token) {
    console.error('Uso: node scripts/realtime_watch.mjs <url-de-la-api> <slug> <access_token>');
    process.exit(2);
}

const stamp = () => new Date().toISOString().slice(11, 23);
let state = null;

const socket = io(url, { path: '/api/v1/realtime', auth: { token }, transports: ['websocket'] });

// Para cada evento, el instante programado que le corresponde (si lo hay).
const scheduled = (event) => ({
    'sim:close': state?.register_close_date,
    'sim:start': state?.start_date,
    'sim:end': state?.end_date,
    'sim:results': state?.results_at,
})[event];

const show = (event, payload) => {
    if (payload) state = payload;
    const target = scheduled(event);
    const drift = target ? ` (${((Date.now() - new Date(target).getTime()) / 1000).toFixed(2)} s del instante programado)` : '';
    console.log(`${stamp()}  ${event.padEnd(12)} phase=${payload?.phase} results_published=${payload?.results_published}${drift}`);
};

for (const event of ['sim:state', 'sim:close', 'sim:start', 'sim:end', 'sim:results', 'sim:updated']) {
    socket.on(event, (payload) => show(event, payload));
}

socket.on('connect', async () => {
    console.log(`${stamp()}  conectado (${socket.id})`);
    const ack = await socket.emitWithAck('join', { slug });
    if (!ack.ok) {
        console.error(`${stamp()}  join rechazado: ${ack.code}`);
        process.exit(1);
    }
    console.log(`${stamp()}  en la sala de ${slug}; esperando eventos (Ctrl+C para salir)`);
});
socket.on('connect_error', (error) => console.error(`${stamp()}  connect_error: ${error.message}`));
socket.on('disconnect', (reason) => console.log(`${stamp()}  desconectado: ${reason}`));
