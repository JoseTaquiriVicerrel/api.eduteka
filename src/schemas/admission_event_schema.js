import mongoose from 'mongoose';
import crypto from 'crypto';
const { Schema } = mongoose;

// Un hito del proceso de admision de una institucion (inscripcion, examen,
// resultados...). Es lo que pinta el calendario publico y lo que se le muestra
// al usuario en su perfil.
export const EVENT_KINDS = ['inscripcion', 'examen', 'resultados', 'matricula', 'otro'];
export const EVENT_KIND_LABELS = {
  inscripcion: 'Inscripción',
  examen: 'Examen',
  resultados: 'Resultados',
  matricula: 'Matrícula',
  otro: 'Otro',
};
export const EVENT_ORIGINS = ['manual', 'ai'];
// published: visible. pending_review: la IA lo propone y falta que un admin lo
// apruebe. rejected: un admin lo descarto (se conserva para que la siguiente
// corrida no lo vuelva a proponer). archived: ya no aplica.
export const EVENT_STATUSES = ['published', 'pending_review', 'rejected', 'archived'];

const admissionEventSchema = new Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  institution_id: { type: String, ref: 'Institution', required: true },
  title: { type: String, required: true, trim: true },
  kind: { type: String, enum: EVENT_KINDS, required: true },
  // Opcional. Vacio = aplica a todas las modalidades de la institucion.
  modality: { type: String, default: '', trim: true },
  // Proceso al que pertenece ('2027-I', 'Admisión 2027').
  period: { type: String, default: '', trim: true },
  // Distingue hitos del mismo tipo dentro de un proceso ('primera fase',
  // 'segunda fase', 'simulacro'). Junto con kind, period y modality es la clave
  // de la deduplicacion; vacio cuando el proceso solo tiene uno de ese tipo.
  phase: { type: String, default: '', trim: true },

  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  all_day: { type: Boolean, default: true },
  url: { type: String, default: '' },
  notes: { type: String, default: '' },

  origin: { type: String, enum: EVENT_ORIGINS, default: 'manual' },
  status: { type: String, enum: EVENT_STATUSES, default: 'published' },
  // Todo lo creado o editado a mano queda bloqueado: la IA no lo sobrescribe,
  // solo puede dejar una propuesta en proposed_changes.
  locked: { type: Boolean, default: false },

  fingerprint: { type: String, required: true },

  // Trazabilidad de lo que viene de la IA.
  source_id: { type: String, default: null },
  source_url: { type: String, default: '' },
  evidence: { type: String, default: '' },
  confidence: { type: Number, default: null },
  ai_model: { type: String, default: '' },
  ai_at: { type: Date, default: null },
  // Ultima vez que una fuente confirmo estas fechas ("verificado el ...").
  verified_at: { type: Date, default: null },
  // Cambio propuesto sobre un evento ya publicado o bloqueado:
  // { title, start_date, end_date, evidence, confidence, source_url, at }
  proposed_changes: { type: Object, default: null },
  // Por que quedo en revision (se muestra al admin).
  review_reason: { type: String, default: '' },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false
});

admissionEventSchema.index({ institution_id: 1, fingerprint: 1 }, { unique: true });
admissionEventSchema.index({ status: 1, start_date: 1 });
admissionEventSchema.index({ institution_id: 1, status: 1, end_date: 1 });

export default admissionEventSchema;
