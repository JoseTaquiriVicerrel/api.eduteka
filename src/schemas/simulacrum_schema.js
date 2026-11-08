import mongoose from 'mongoose';
import crypto from 'crypto';

const simulacrumSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  exam_id: String,
  description: String,
  title: String,
  areas: Object,
  price: Number,
  slug: String,
  institution: { type: Object, ref: 'Institution' },
  verified: { type: Boolean, default: false },
  date_program: Date,
  start_date: Date,
  end_date: Date,
  // Simulacro programado (en vivo): cierre de inscripciones (vacio = start_date) y publicacion
  // programada de resultados (vacio = al terminar la ventana). Opcionales y sin default: la API
  // comparte base con el monolito y no migra datos.
  register_close_date: Date,
  results_public_at: Date,
  time: Number,
  image_post: String,
  score: Number,
  general: { type: Boolean, default: true },
  duration: Number,
  automatic: { type: Boolean, default: false },
  finished: { type: Boolean, default: false },
  questions: Object,
  prospect: { type: String, ref: 'Prospect' },
  state: { type: Boolean, default: true },// true: visible, false: hidden
  score_correct: Number,
  score_incorrect: Number,
  score_not_answered: Number,
  for_register: { type: Boolean, default: true },
  public_results: Boolean,
  calification_type: String,
  general_items: Array,
  assigned_editor_id: { type: String, ref: 'User' },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default simulacrumSchema;
