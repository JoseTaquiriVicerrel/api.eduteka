import mongoose from 'mongoose';
import crypto from 'crypto';

const { Schema } = mongoose;

/**
 * Refresh token de la API. Coleccion PROPIA de la API: el monolito no la lee.
 *
 * Solo se guarda el SHA-256 del token. Cada uso lo "rota": el documento viejo
 * queda revocado y apunta al nuevo (`replaced_by`); todos los de una misma
 * cadena comparten `family_id`. Presentar un token ya rotado significa que
 * alguien lo copio, y se revoca la familia entera.
 */
const refreshTokenSchema = new Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    user_id: { type: String, ref: 'User', required: true },
    family_id: { type: String, required: true },
    token_hash: { type: String, required: true },
    expires_at: { type: Date, required: true },
    revoked_at: { type: Date, default: null },
    replaced_by: { type: String, default: null },
    device: {
        name: { type: String, maxlength: 100 },
        platform: { type: String, maxlength: 30 },
        app_version: { type: String, maxlength: 30 },
    },
    ip: { type: String },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    // La API no crea indices de las colecciones que comparte con el monolito
    // (mongoose.set('autoIndex', false) en el arranque). Esta si es suya, y sin
    // sus indices no habria unicidad del hash ni caducidad automatica.
    autoIndex: true,
});

refreshTokenSchema.index({ token_hash: 1 }, { unique: true });
// Borra el documento cuando vence (el monitor TTL corre cada ~60 s).
refreshTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ user_id: 1 });
refreshTokenSchema.index({ family_id: 1 });

export default refreshTokenSchema;
