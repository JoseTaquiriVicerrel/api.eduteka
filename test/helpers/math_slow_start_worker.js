import { parentPort } from 'node:worker_threads';

// Worker de prueba: tarda en arrancar (como MathJax cargando) y despues responde al instante.
// Con MATH_NEVER_READY nunca avisa que esta listo.
if (!process.env.MATH_NEVER_READY) setTimeout(() => parentPort.postMessage({ ready: true }), 700);
parentPort.on('message', ({ id }) => {
    parentPort.postMessage({ id, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="8px" height="8px"></svg>', w: '1ex', h: '1ex', valign: '0' });
});
