import { logActivity } from '#Libs/activity_log.js';

// Bitacora de actividad (la misma coleccion que lee el panel del monolito) desde la API.
// `logActivity` toma la identidad de `res.locals` (sesion del monolito); aqui no existe,
// asi que se pasa explicita desde `req.user`. `metadata.via` distingue lo que llego por
// la API. Igual que logActivity: se llama sin `await` y nunca falla hacia el cliente.
export const logUserActivity = (req, user, { metadata, ...data }) => logActivity(req, null, {
    user_id: user._id,
    user_rol: user.rol ?? null,
    user_email: user.email ?? null,
    user_name: user.fullname ?? user.username ?? null,
    user_account_type: user.account_type ?? null,
    ...data,
    metadata: { ...metadata, via: 'api' },
});

export default logUserActivity;
