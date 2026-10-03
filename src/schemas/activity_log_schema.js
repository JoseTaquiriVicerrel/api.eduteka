import mongoose from 'mongoose';
import crypto from 'crypto';
import { ACTIVITY_ACTIONS, ACTIVITY_CATEGORIES } from '#Libs/activity_actions.js';

/**
 * Registro de auditoria de acciones de usuario.
 *
 * Un documento por accion de negocio efectivamente ocurrida. Nunca se actualiza
 * ni se borra a mano: es un log, no un estado. Solo audita — no bloquea, no
 * limita y no puede hacer fallar la accion que registra (ver #Libs/activity_log.js).
 *
 * Existe porque hasta ahora la unica forma de saber "quien hizo que y cuando"
 * era mirar el estado final del documento, y ese estado se sobreescribe: quien
 * aprobo una pregunta solo vive en `verified_by` hasta la siguiente edicion, y
 * quien renovo una suscripcion se pierde al renovar otra vez.
 *
 * Deliberadamente NO cubre las descargas de archivos: esas tienen su propia
 * coleccion con mas detalle (#Schemas/download_schema.js). El catalogo completo
 * de lo que si entra —y de lo que se excluye a proposito— esta en
 * #Libs/activity_actions.js.
 */

// Retencion del log. A diferencia de `Download`, que se guarda indefinidamente
// porque escribe una fila por descarga, esto escribe una por login, favorito e
// inscripcion: sin techo la coleccion crece sin control.
//
// La variable se valida en vez de confiar en Number(): un
// `ACTIVITY_LOG_TTL_DAYS=` vacio en el .env da Number('') === 0, y un TTL de 0
// segundos no desactiva nada, borra cada documento apenas se escribe.
const DEFAULT_TTL_DAYS = 365;
const configuredTtlDays = Number(process.env.ACTIVITY_LOG_TTL_DAYS);
const TTL_DAYS = Number.isFinite(configuredTtlDays) && configuredTtlDays > 0
    ? configuredTtlDays
    : DEFAULT_TTL_DAYS;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

const activityLogSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    action: { type: String, enum: Object.values(ACTIVITY_ACTIONS), required: true },
    // Prefijo de `action`. Se guarda desnormalizada para que el filtro por
    // categoria del panel sea un indice y no un $regex sobre `action`.
    category: { type: String, enum: ACTIVITY_CATEGORIES, required: true },
    // 'failed' hoy solo lo usa auth.login_failed. El campo existe igual para
    // todas las acciones porque un intento rechazado es tan auditable como uno
    // exitoso, y agregarlo despues obligaria a reinterpretar el historico.
    status: { type: String, enum: ['success', 'failed'], default: 'success' },
    // Quien actua. 'anonymous' es un caso real, no un error: se puede marcar un
    // examen como favorito sin sesion. 'system' lo escriben los procesos del
    // cron, que no tienen request detras.
    actor_type: { type: String, enum: ['user', 'admin', 'system', 'anonymous'], default: 'user' },
    // Sin `required`: un login fallido con un correo inexistente y un favorito
    // anonimo no tienen usuario, y son justamente eventos que hay que registrar.
    user_id: { type: String, ref: 'User' },
    // Snapshot de la identidad al momento de actuar. Mismo criterio que
    // download_schema: el usuario puede renombrarse, cambiar de rol o ser
    // eliminado, y el log tiene que seguir diciendo quien era entonces.
    // En auth.login_failed `user_email` es el correo intentado, que puede no
    // corresponder a ninguna cuenta.
    user_email: { type: String },
    user_name: { type: String },
    user_rol: { type: String },
    user_account_type: { type: String },
    // Objeto sobre el que se actua, polimorfico: 'exam', 'question',
    // 'simulacrum', 'user', 'payment', 'list', 'order'...
    target_type: { type: String },
    target_id: { type: String },
    // Examenes y simulacros se navegan por slug, no por id: sin esto no se puede
    // armar el enlace al recurso desde el panel.
    target_slug: { type: String },
    // Snapshot del titulo, por lo mismo que el nombre del usuario.
    target_name: { type: String },
    /**
     * Detalle propio de cada accion, sin tipar (mismo criterio que
     * `user.suscription`). Lo que se espera guardar:
     *   auth.login_failed              { reason: 'bad_password'|'not_verified'|'user_not_found' }
     *   exam.favorited/unfavorited     { favorites_count }
     *   question.verified              { previous_state, previous_verified }
     *   simulacrum.enrolled            { amount_paid, state, status_reason }
     *   simulacrum.finished            { score, questions_correct, questions_incorrect }
     *   subscription.payment_*         { amount, suscription_name, start_date, end_date }
     */
    metadata: { type: Object },
    ip: { type: String },
    user_agent: { type: String },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

// TTL y, a la vez, el indice del listado del panel: mongo recorre un indice de
// un solo campo en cualquier direccion, asi que este mismo sirve para ordenar
// por fecha descendente y no hace falta un { created_at: -1 } aparte.
//
// OJO: mongoose no modifica un indice TTL que ya existe (falla con
// IndexOptionsConflict y solo lo deja en consola). Si se cambia
// ACTIVITY_LOG_TTL_DAYS hay que aplicarlo a mano sobre la coleccion:
//   db.runCommand({ collMod: 'activitylogs',
//     index: { keyPattern: { created_at: 1 }, expireAfterSeconds: <nuevo> } })
activityLogSchema.index({ created_at: 1 }, { expireAfterSeconds: TTL_SECONDS });
// "que hizo este usuario", el historial que se abre desde la ficha del usuario.
activityLogSchema.index({ user_id: 1, created_at: -1 });
// Filtro por accion del panel.
activityLogSchema.index({ action: 1, created_at: -1 });
// Filtro por categoria del panel.
activityLogSchema.index({ category: 1, created_at: -1 });
// "quien toco este examen / esta pregunta", partiendo del recurso.
activityLogSchema.index({ target_type: 1, target_id: 1, created_at: -1 });

export default activityLogSchema;
