import { parentPort } from 'node:worker_threads';

// Worker de prueba: 'hang' se queda en un bucle infinito; cualquier otra cosa responde bien.
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ id, tex }) => {
    if (tex === 'hang') for (;;) { /* bloquea el hilo */ }
    parentPort.postMessage({ id, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="8px" height="8px"></svg>', w: '1ex', h: '1ex', valign: '0' });
});
