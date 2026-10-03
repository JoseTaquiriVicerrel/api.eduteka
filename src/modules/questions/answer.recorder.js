import { randomUUID } from 'node:crypto';
import QuestionModel from '#Models/question_model.js';
import UserAnswerModel from '#Models/user_answer_model.js';
import { invalidateProgress } from '#Modules/progress/progress.cache.js';

// Registro de respuestas de un usuario y de los contadores de la comunidad.
//
// Regla: cada usuario cuenta UNA vez por pregunta. Responder lo mismo otra vez no
// cambia nada; cambiar de opcion MUEVE el voto (el total no cambia). Es el unico
// sitio que escribe `UserAnswer` y `options_answers`/`total_answers`, para que
// /preguntas/:id/responder y el cierre de las practicas se comporten igual.
//
// Los contadores se actualizan con $inc atomicos (nunca leyendo y guardando la
// pregunta): dos respuestas simultaneas no se pisan, no se disparan los hooks de
// guardado del schema y `updated_at` no cambia por cada voto.

const KEY_PATTERN = /^[A-Za-z0-9]{1,3}$/;

// Los contadores pueden faltar o ser null en preguntas que nadie ha respondido, y
// `$inc` sobre null falla. Se inicializan a cero con las claves de las opciones
// (el monolito espera ver todas las opciones en `options_answers`).
const ensureCounters = async (questions) => {
    for (const { id, keys } of questions) {
        const zeroes = Object.fromEntries(keys.map((key) => [key, 0]));
        await QuestionModel.updateOne({ _id: id, options_answers: null }, { $set: { options_answers: zeroes } }, { timestamps: false }).exec();
        await QuestionModel.updateOne({ _id: id, total_answers: null }, { $set: { total_answers: 0 } }, { timestamps: false }).exec();
    }
};

/**
 * @param {object} args
 * @param {string} args.userId
 * @param {{ questionId: string, keys: string[], selected: string }[]} args.items
 *        `keys` son las alternativas validas de la pregunta; `selected` ya viene validada.
 * @param {(stats: { created: number, changed: number }) => Promise<void>} [args.beforeWrite]
 *        Se llama con el conteo ANTES de escribir nada (para aplicar el cupo diario);
 *        si lanza, no se escribe nada.
 * @returns {Promise<{ created: number, changed: number, unchanged: number }>}
 */
export const recordAnswers = async ({ userId, items, beforeWrite }) => {
    if (items.length === 0) return { created: 0, changed: 0, unchanged: 0 };

    const existing = await UserAnswerModel
        .find({ user_id: userId, question_id: { $in: items.map((item) => item.questionId) } }, { question_id: 1, answer: 1 })
        .lean()
        .exec();

    // Puede haber filas duplicadas por (usuario, pregunta) en la base: se usa la primera.
    const previousByQuestion = new Map();
    for (const row of existing) if (!previousByQuestion.has(row.question_id)) previousByQuestion.set(row.question_id, row);

    const inserts = [];
    const answerUpdates = [];
    const counterOps = [];
    const toInitialize = [];
    let unchanged = 0;

    for (const { questionId, keys, selected } of items) {
        const previous = previousByQuestion.get(questionId);

        if (!previous) {
            inserts.push({ _id: randomUUID(), user_id: userId, question_id: questionId, answer: selected });
            toInitialize.push({ id: questionId, keys });
            counterOps.push({
                updateOne: {
                    filter: { _id: questionId },
                    update: { $inc: { [`options_answers.${selected}`]: 1, total_answers: 1 } },
                },
            });
        } else if (previous.answer !== selected) {
            answerUpdates.push({ updateOne: { filter: { _id: previous._id }, update: { $set: { answer: selected } } } });
            toInitialize.push({ id: questionId, keys });
            // Solo se resta si el contador anterior es positivo: los datos antiguos pueden estar desfasados.
            if (KEY_PATTERN.test(String(previous.answer))) {
                counterOps.push({
                    updateOne: {
                        filter: { _id: questionId, [`options_answers.${previous.answer}`]: { $gt: 0 } },
                        update: { $inc: { [`options_answers.${previous.answer}`]: -1 } },
                    },
                });
            }
            counterOps.push({ updateOne: { filter: { _id: questionId }, update: { $inc: { [`options_answers.${selected}`]: 1 } } } });
        } else {
            unchanged += 1;
        }
    }

    const stats = { created: inserts.length, changed: answerUpdates.length };
    if (beforeWrite) await beforeWrite(stats);

    if (inserts.length) await UserAnswerModel.insertMany(inserts, { ordered: false });
    if (answerUpdates.length) await UserAnswerModel.bulkWrite(answerUpdates);
    if (toInitialize.length) await ensureCounters(toInitialize);
    if (counterOps.length) await QuestionModel.bulkWrite(counterOps, { timestamps: false, ordered: true });

    // El dashboard de progreso se calcula a partir de estas respuestas.
    if (stats.created + stats.changed > 0) await invalidateProgress(userId);

    return { ...stats, unchanged };
};
