// Tope de lo que se llega a leer de un cuerpo que vamos a descartar. Por encima
// se corta el socket: llegados ahi el cliente ya no esta subiendo un PDF de
// clase. Coincide con el limite duro de multer en #Config/upload.js.
const MAX_DRAIN_BYTES = 25 * 1024 * 1024;

/**
 * Responde a una peticion cuyo cuerpo todavia se esta subiendo.
 *
 * Si se contesta y se cierra el socket mientras el navegador sigue escribiendo
 * el multipart, el cliente no ve la respuesta: ve un ECONNRESET. Con un PDF de
 * varios MB pasa siempre. Aqui se descarta lo que queda del cuerpo -- sin
 * escribirlo a disco ni acumularlo en memoria, que es justo lo que se queria
 * evitar rechazando antes del uploader -- y se responde cuando termina.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} status
 * @param {object} payload cuerpo JSON de la respuesta
 */
export const rejectAndDrain = (req, res, status, payload) => {
    const send = () => {
        if (res.headersSent) return;
        res.status(status).json(payload);
    };

    // Cuerpo ya consumido (o peticion sin cuerpo): se responde directamente.
    if (req.complete || req.readableEnded) return send();

    let read = 0;

    req.on('data', (chunk) => {
        read += chunk.length;
        if (read > MAX_DRAIN_BYTES) {
            send();
            req.destroy();
        }
    });
    req.on('end', send);
    // El cliente corto antes de terminar: no hay a quien responder.
    req.on('error', () => {});
    req.on('aborted', () => {});

    req.resume();
};

export default rejectAndDrain;
