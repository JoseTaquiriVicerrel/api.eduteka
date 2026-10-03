import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * Intento ARCHIVADO de un simulacro.
 *
 * `UserSimulacrum` sigue siendo el documento vivo: guarda la inscripcion (pago,
 * comprobante, monto, area elegida) y, encima de eso, el ULTIMO intento del
 * postulante. Es lo que leen el ranking, el panel de inscritos, el solucionario
 * y el dashboard de ingresos; ninguno de esos tuvo que cambiar.
 *
 * Cuando el usuario vuelve a rendir, el intento que estaba en `UserSimulacrum`
 * se copia aqui y los campos del intento se limpian para empezar de cero. Asi
 * "el ultimo intento es el que se ve en los resultados" sale gratis y el avance
 * anterior no se pierde. Este documento es de solo lectura una vez escrito.
 */
const simulacrumAttemptSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  // Inscripcion de la que salio el intento. Es la llave real: un usuario tiene
  // una sola inscripcion por simulacro y todos sus intentos cuelgan de ella.
  user_simulacrum_id: { type: String, ref: 'UserSimulacrum', required: true },
  user_id: { type: String, ref: 'User', required: true },
  simulacrum_id: { type: String, ref: 'Simulacrum', required: true },
  // 1 para el intento original. El intento vivo en `UserSimulacrum` siempre
  // tiene el numero mas alto.
  attempt_number: { type: Number, required: true },
  // Se copian para que el historial se pueda leer sin volver a la inscripcion:
  // el area determina que preguntas se rindieron y como se califico.
  area: String,
  career: String,
  answers: Object,
  start_exam: Date,
  end_exam: Date,
  exam_finished: Date,
  time: Number,
  score: Number,
  score_conversion: Number,
  results: Object,
  ai_analysis: Object,
  questions_correct: Number,
  questions_incorrect: Number,
  questions_not_answered: Number,
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false
});

// Doble proposito. Ordena el historial que se pinta en /resultados y, sobre
// todo, hace idempotente el archivado: si el usuario da doble clic en
// "Volver a rendir", el segundo insert choca contra el indice en vez de
// duplicar el intento.
simulacrumAttemptSchema.index({ user_simulacrum_id: 1, attempt_number: 1 }, { unique: true });

// Historial de intentos de un postulante en /mi-progreso.
simulacrumAttemptSchema.index({ user_id: 1 });

export default simulacrumAttemptSchema;
