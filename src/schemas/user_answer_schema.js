import mongoose from 'mongoose';
import crypto from 'crypto';

const userAnswerSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    user_id: { type: String, require: true },
    question_id: { type: String, ref: 'Question' },
    answer: String,
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

// NO unico a proposito: la regla "una fila por (usuario, pregunta)" solo la
// imponen los controladores con find-then-insert, y ya hay duplicados en la
// base. Cubre el findOne({question_id, user_id}) que corre antes de guardar cada
// respuesta (antes era un COLLSCAN) y la carga del historial en /mi-progreso.
userAnswerSchema.index({ user_id: 1, question_id: 1 });

// Rango de fechas del panel /admin/progreso.
userAnswerSchema.index({ created_at: 1 });

export default userAnswerSchema;
