import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * Registro de auditoria de descargas de recursos.
 *
 * Un documento por descarga efectivamente entregada. Nunca se actualiza ni se
 * borra: es un log, no un estado. Solo audita — no bloquea ni limita nada.
 *
 * Unifica los dos caminos por los que hoy sale un archivo:
 *   - `store`        -> compra en la tienda, gate = Order con status 'verified'
 *                       (#Controllers/download.controllers.js)
 *   - `subscription` -> suscripcion activa, gate = authorize("Auth", true)
 *                       (#Controllers/exam_download.controllers.js)
 *   - `material`     -> docx generado en el editor de materiales, gate =
 *                       authorize("Administrador")
 *                       (#Controllers/material.controllers.js)
 */
const downloadSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    user_id: { type: String, required: true, ref: 'User' },
    // Rol del usuario al momento de descargar. Los administradores pasan por
    // `authorize` sin pedido ni suscripcion, y sus descargas ensuciarian las
    // metricas si no se pudieran separar.
    user_rol: { type: String },
    // Tipo de cuenta ("Estudiante" / "Profesor"), tambien al momento de
    // descargar. Es un campo distinto de `rol` y no se puede derivar de el: un
    // profesor es `rol: "User"` igual que un estudiante, asi que sin esto las
    // descargas de materiales del profesorado no se distinguen de las demas.
    user_account_type: { type: String },
    // Camino de acceso que habilito la descarga.
    source: { type: String, enum: ['store', 'subscription', 'material'], required: true },
    resource_type: { type: String, enum: ['product', 'exam', 'material'], required: true },
    resource_id: { type: String, required: true },
    // Solo examenes: la ruta publica es por slug, no por id.
    resource_slug: { type: String },
    // Snapshot del nombre: el producto/examen puede renombrarse despues.
    resource_name: { type: String },
    area: { type: String },
    file_name: { type: String },
    file_path: { type: String },
    // Solo source='store'.
    order_id: { type: String, ref: 'Order' },
    // Solo source='subscription'. Snapshot { name, end_date, institution_id }:
    // `user.suscription` se sobreescribe al renovar y el historico se perderia.
    // Sin tipar, igual que `suscription` en user_schema.js.
    subscription: { type: Object },
    ip: { type: String },
    user_agent: { type: String },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

// Listado del panel admin, ordenado por fecha descendente.
downloadSchema.index({ created_at: -1 });
// "que descargo este usuario" + base para futuros topes por usuario.
downloadSchema.index({ user_id: 1, created_at: -1 });
// Ranking de recursos mas descargados del dashboard.
downloadSchema.index({ resource_id: 1, created_at: -1 });
// Filtro por origen del panel admin.
downloadSchema.index({ source: 1, created_at: -1 });

export default downloadSchema;
