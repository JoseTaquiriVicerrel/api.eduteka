/**
 * Preguntas de un simulacro listas para pintar: examen (/proceso) y solucionario.
 *
 * Las vistas pintan el snapshot que el simulacro guarda en `general_items` /
 * `areas[K].questions`, y ese snapshot no siempre sirve tal cual:
 *
 * - `options` llega en dos formas segun quien armo el simulacro: objeto
 *   `{A: '...', B: '...'}` (questionItemSimulacrum, question_sync) o arreglo ya
 *   mapeado `[{opt, option}]` (autoAssembleArea). El solucionario recorria el
 *   objeto como si fuera el arreglo y todas las opciones salian vacias.
 * - La ingesta por texto de simulacros de prospecto guarda la pregunta solo
 *   como referencia (`{itype, id}`) y la completa despues, en la correccion
 *   final. Si ese paso no llega a cubrirla, el simulacro queda con preguntas sin
 *   enunciado, opciones ni clave (simulacro-beca-18-2023). Las vistas las
 *   completan aqui con la coleccion `questions`; los datos se reparan con
 *   scripts/fix_simulacrum_incomplete_questions.js.
 */
import { get_options_map } from '#Libs/functions.js';

/** Lo que las vistas pintan de cada pregunta. */
export const QUESTION_FIELDS = ['question', 'options', 'rpta', 'resolution', 'topic', 'area'];

// El editor deja '<p><br></p>' cuando se borra el contenido: tambien es un hueco.
const isBlank = (value) => value === undefined || value === null || value === '' || value === '<p><br></p>';

const hasOptions = (options) => Boolean(options) && Object.keys(options).length > 0;

/**
 * Pregunta cuyo snapshot no se puede pintar: le falta el enunciado, las
 * opciones o la clave. La resolucion y el tema no cuentan: muchas preguntas
 * legitimamente no los tienen.
 */
export const isIncompleteQuestion = (item) => item?.itype === 'question'
    && (isBlank(item.question) || isBlank(item.rpta) || !hasOptions(item.options));

const firstFilled = (primary, fallback) => {
    if (!isBlank(primary)) return primary;
    if (!isBlank(fallback)) return fallback;
    return null;
};

/**
 * Junta el snapshot con la pregunta canonica: la fuente `primary` manda y la
 * otra solo rellena huecos.
 *
 * @param {boolean} canonicalFirst true cuando manda la canonica.
 */
export const completeQuestion = (snapshot, canonical, canonicalFirst = false) => {
    if (!canonical) return snapshot;

    const [primary, fallback] = canonicalFirst ? [canonical, snapshot] : [snapshot, canonical];
    const merged = { ...snapshot };
    for (const field of QUESTION_FIELDS) {
        merged[field] = firstFilled(primary[field], fallback[field]);
    }
    return merged;
};

/**
 * Preguntas del solucionario.
 *
 * La clave sale de la misma fuente que usa `saveCalificationUserController`:
 * la canonica en los simulacros de prospecto (`canonicalFirst`), el snapshot en
 * el resto. Asi el solucionario nunca marca como correcta una opcion distinta
 * de la que conto la nota.
 *
 * @param {object[]} items preguntas y bloques del simulacro, en orden.
 * @param {object} [context]
 * @param {Map<string, object>} [context.canonicalById] preguntas de `questions` por `_id`.
 * @param {boolean} [context.canonicalFirst] true en simulacros de prospecto.
 * @param {object} [context.answers] `userSimulacrum.answers`.
 */
export const buildSolutionQuestions = (items, { canonicalById = new Map(), canonicalFirst = false, answers = {} } = {}) => {
    let nq = 0;

    return items.map((item) => {
        if (item?.itype !== 'question') return item;

        nq++;
        const question = completeQuestion(item, canonicalById.get(item.id), canonicalFirst);

        return {
            ...question,
            nq,
            options: Array.isArray(question.options) ? question.options : get_options_map(question),
            opt_answer: answers?.[item.id]?.option,
        };
    });
};
