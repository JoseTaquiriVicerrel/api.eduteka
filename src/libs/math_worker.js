import { parentPort } from 'node:worker_threads';
import { renderSvg } from '#Libs/math_render.js';

// Hilo de MathJax: recibe { id, tex, display } y responde { id, ...resultado } o { id, error }.
parentPort.on('message', ({ id, tex, display }) => {
    try {
        parentPort.postMessage({ id, ...renderSvg({ tex, display }) });
    } catch (error) {
        parentPort.postMessage({ id, error: String(error?.message ?? error) });
    }
});

// Calienta MathJax (carga de fuentes y paquetes) y avisa: el timeout por formula empieza despues.
renderSvg({ tex: 'x', display: false });
parentPort.postMessage({ ready: true });
