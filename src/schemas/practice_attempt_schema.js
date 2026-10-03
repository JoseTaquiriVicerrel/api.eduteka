import mongoose from 'mongoose';
import crypto from 'crypto';

const { Schema } = mongoose;

const practiceAttemptSchema = new Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  user_id: { type: String, ref: "User", required: true },
  // Deja de ser obligatorio: la practica por area de la app movil se genera al
  // vuelo con $sample y no tiene una UserQuestionsList detras. Los intentos que
  // vienen de una lista lo siguen rellenando igual, asi que nada cambia para el
  // flujo web.
  practice_id: { type: String, ref: "UserQuestionsList" },
  practice_slug: String,
  /** "lista" (practica guardada) | "area" (tanda generada por area/tema). */
  source: { type: String, default: "lista" },
  // Solo para source "area": permite reconstruir de que practico el postulante.
  area_id: { type: String, ref: "Area" },
  topic: String,
  answers: Object,
  time: Number,
  total_questions: Number,
  questions_correct: Number,
  questions_incorrect: Number,
  questions_not_answered: Number,
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false
});

// Dias con practica terminada del postulante (/mi-progreso) y rango del panel
// /admin/progreso: una practica cuenta como dia activo.
practiceAttemptSchema.index({ user_id: 1, created_at: -1 });
practiceAttemptSchema.index({ created_at: 1 });

export default practiceAttemptSchema;
