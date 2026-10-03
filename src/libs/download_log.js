import DownloadModel from '#Models/download_model.js';

// Los user-agent reales rondan los 120-250 caracteres, pero nada impide que
// llegue una cabecera de kilobytes. Se corta para no engordar la coleccion.
const MAX_USER_AGENT = 500;

/**
 * Registra una descarga ya autorizada.
 *
 * Se llama JUSTO ANTES de `res.download(...)`, sin `await`: el registro es
 * auditoria y no puede retrasar ni, sobre todo, romper la entrega del archivo.
 * Por eso la promesa se traga cualquier error y solo lo deja en consola.
 *
 *   void logDownload(req, res, { source: 'store', ... });
 *
 * `user_id` sale de `res.locals.user_id` — en este proyecto no existe
 * `req.user`, la sesion vive en `res.locals` (ver #Libs/auth.js).
 */
const logDownload = async (req, res, data) => {
    try {
        const user_id = res.locals.user_id ?? res.locals.user_session?._id;
        if (!user_id) return;

        await DownloadModel.create({
            ...data,
            user_id,
            user_rol: res.locals.user_session?.rol,
            user_account_type: res.locals.user_session?.account_type,
            ip: req.ip,
            user_agent: (req.get('user-agent') ?? '').slice(0, MAX_USER_AGENT),
        });
    } catch (error) {
        // Una descarga legitima no puede fallar porque fallo su log.
        console.error('No se pudo registrar la descarga:', error);
    }
};

export { logDownload };
export default logDownload;
