import mongoose from 'mongoose';
import crypto from 'crypto';

const userSimulacrumSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  user_id: { type: String, ref: "User", required: true },
  dni: String,
  fullname: String,
  area: String,
  simulacrum_id: { type: String, ref: "Simulacrum"},
  career: String,
  answers: Object,
  start_exam: Date,
  end_exam: Date,
  exam_finished: Date, // Fecha de finalización del examen - Sistema - Usuario
  screenshot: String,
  time: Number,
  score: Number,
  score_conversion: Number,
  // Puntaje del PRIMER intento, congelado. `score` sigue al ultimo intento,
  // que es lo que el postulante ve en sus propios resultados; el ranking
  // publico usa este, para que volver a rendir no reordene una tabla que los
  // demas rindieron una sola vez.
  //
  // Ausente en las inscripciones anteriores a los reintentos: como esas nunca
  // reintentaron, su `score` ES el del primer intento y el ranking cae a el
  // con un $ifNull.
  official_score: Number,
  official_score_conversion: Number,
  public_results: { type: Boolean, default: false },
  finished: { type: Boolean, default: false }, // Cierre del simulacro - Usuario - Sistema
  // Numero del intento que este documento representa. Siempre es el ULTIMO:
  // al volver a rendir, el intento anterior se copia a SimulacrumAttempt y
  // este contador sube. Las inscripciones anteriores a esta funcion no lo
  // tienen; el codigo las lee como 1 (ver scripts/backfill_user_simulacrum_attempts.js).
  attempt_number: { type: Number, default: 1 },
  results: Object,
  ai_analysis: Object,
  questions_correct: Number,
  questions_incorrect: Number,
  questions_not_answered: Number,
  state: { type: Boolean, default: false },
  // Motivo por el que el comprobante no se dio por bueno. El controlador de
  // inscripcion ya lo escribia, pero el campo no existia aqui y mongoose lo
  // descartaba en silencio (strict mode), asi que el admin veia el pago
  // rechazado sin saber por que.
  status_reason: { type: String },
  // Monto realmente pagado por esta inscripcion, congelado al inscribirse.
  // Antes el ingreso se deducia de `Simulacrum.price`, que es el precio vigente
  // y no el historico: al cambiarlo se reescribian las ventas de meses ya
  // cerrados. 0 = inscripcion gratuita.
  amount_paid: { type: Number, default: 0 }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

// El dashboard de ingresos filtra por rango de fechas, estado y monto pagado.
userSimulacrumSchema.index({ created_at: -1, state: 1, amount_paid: 1 });

// Simulacros de un postulante (/perfil, /mi-progreso) y los findOne por
// (simulacro, usuario) del flujo de inscripcion y examen: no habia indice por
// usuario.
userSimulacrumSchema.index({ user_id: 1, simulacrum_id: 1 });

export default userSimulacrumSchema;
