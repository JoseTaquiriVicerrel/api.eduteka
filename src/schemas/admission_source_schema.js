import mongoose from 'mongoose';
import crypto from 'crypto';
const { Schema } = mongoose;

// Enlace que se consulta para sacar las fechas de admision de una institucion
// (la pagina de admision de la universidad, un cronograma en PDF, etc.).
// El resultado de la ultima corrida vive en el propio documento, como hacen
// ai_status / figure_status en las preguntas: no hay cola ni worker aparte.
export const SOURCE_TYPES = ['web', 'pdf'];
export const SOURCE_STATUSES = ['ok', 'unchanged', 'empty', 'failed'];

const admissionSourceSchema = new Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  institution_id: { type: String, ref: 'Institution', required: true, index: true },
  url: { type: String, required: true },
  label: { type: String, default: '' },
  type: { type: String, enum: SOURCE_TYPES, default: 'web' },
  // Solo una fuente oficial (la web de la propia institucion) puede publicar
  // sin revision. Un portal de terceros siempre pasa por un admin.
  official: { type: Boolean, default: true },
  active: { type: Boolean, default: true },

  // 'running' marca una corrida en curso: si se queda mas de
  // STALE_RUNNING_MINUTES se considera encallada y se puede reintentar.
  running_since: { type: Date, default: null },

  last_fetched_at: { type: Date, default: null },
  // Hash del texto normalizado de la pagina: si no cambia, no se llama a la IA.
  last_hash: { type: String, default: null },
  last_status: { type: String, enum: [...SOURCE_STATUSES, null], default: null },
  last_error: { type: String, default: null },
  last_events_found: { type: Number, default: 0 },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false
});

admissionSourceSchema.index({ institution_id: 1, url: 1 }, { unique: true });

export default admissionSourceSchema;
