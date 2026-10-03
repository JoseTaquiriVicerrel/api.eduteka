/**
 * Express 4 no captura los rechazos de un handler `async`: el error se convierte
 * en un unhandledRejection y la peticion queda colgada hasta el timeout.
 *
 * Envuelve un handler async para que cualquier rechazo llegue al middleware de
 * errores de `src/config/express.js`.
 *
 *   router.post('/ruta', authorize("Administrador"), asyncHandler(miController));
 */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Aplica `asyncHandler` a una lista de handlers de una sola vez, para no tener
 * que envolverlos uno a uno al registrar las rutas.
 */
const asyncAll = (...fns) => fns.map((fn) => asyncHandler(fn));

export { asyncHandler, asyncAll };
export default asyncHandler;
