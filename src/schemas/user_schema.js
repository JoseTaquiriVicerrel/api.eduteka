import mongoose from "mongoose";
import { randomUUID } from "crypto";

const { Schema } = mongoose;

const UserSchema = new Schema({
    _id: { type: String, default: randomUUID },
    name: { type: String, trim: true },
    username: { type: String, trim: true },
    fullname: { type: String, trim: true },
    dni: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true, unique: true },
    document_number: { type: String, trim: true },
    password: { type: String, select: false },
    state: { type: Boolean, default: true },
    rol: { type: String }, // Admin, User
    account_type: { type: String }, // Estudiante, Profesor
    // Momento del unico cambio de tipo de cuenta que el usuario puede hacer desde
    // /perfil. null = aun no lo ha cambiado. Despues, solo un admin lo modifica.
    account_type_changed_at: { type: Date, default: null },
    departament: { type: String },
    university: { type: String, ref: "Institution" },
    // Curso (area) que enseña. Solo aplica a cuentas Profesor; lo pide el
    // registro en lugar de la institucion de preferencia del estudiante.
    teaching_area: { type: String, ref: "Area" },
    suscription: { type: Object },
    avatar: { type: String },
    suscription_notified: { type: Boolean, default: false },
    suscription_history: { type: Array, default: [] },
    notification_subscription_renovation: { type: Boolean, default: false },
    notification_subscription_expiration: { type: Boolean, default: false },
    created_by: { type: String },
    token_verify: { type: String },
    token_recovery_verify: { type: String },
    // Vencimiento del codigo de recuperacion (10 min). Sin el, un codigo viejo
    // seguia valiendo hasta que la contraseña cambiara.
    token_recovery_expires: { type: Date },
    points_rank: { type: Number },
    count_question: { type: Number },
    count_verified: { type: Number },
    notification_send: { type: Boolean, default: false },
    count_pending: { type: Number },
    mock_exam: { type: Object },
    last_session: { type: Date },
    notification: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    // OBSOLETO. Fue la llave de entrada a la beta de docentes mientras esta era
    // cerrada. Ya no lo lee nadie: la beta esta abierta a toda cuenta de tipo
    // Profesor. Se conserva porque hay documentos con el valor puesto a mano y
    // borrar el campo del esquema no borra el dato; ver beta_teacher_blocked.
    access_beta_teacher: { type: Boolean, default: false },
    // Veto por usuario de la beta de docentes. El sentido es el contrario del
    // campo de arriba a proposito: la beta esta abierta, asi que lo excepcional
    // -- y por tanto lo que merece guardarse -- es a quien se le ha cortado.
    //
    // Es el unico corte fino que existe sobre estas funciones; lo siguiente es
    // desactivar la cuenta entera. Lo escribe un administrador desde /usuarios.
    // Tiene que estar en SESSION_USER_FIELDS (#Libs/auth.js) para llegar a
    // res.locals.
    beta_teacher_blocked: { type: Boolean, default: false },
    // Cuando se le envio la invitacion a probar la beta de materiales. Lo escribe
    // scripts/send_beta_materials_invite.js y es lo que evita invitar dos veces.
    beta_materials_invited_at: { type: Date },

    // --- Campos de la API JSON (/api/v1/auth). El monolito no los usa. ---
    // El codigo de 6 digitos se guarda como HMAC (no en claro) en `token_verify` /
    // `token_recovery_verify`; estos campos llevan su vencimiento y los intentos
    // fallidos. Si otro sistema comparte esta coleccion, estos campos hay que
    // mantenerlos en su copia del schema (strict los descartaria al guardar).
    token_verify_expires: { type: Date },
    token_verify_attempts: { type: Number },
    token_recovery_attempts: { type: Number },
    // `jti` del unico token de restablecimiento vigente. Se borra al usarlo.
    password_reset_jti: { type: String },
}, {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    },
    versionKey: false
});

export default UserSchema;
