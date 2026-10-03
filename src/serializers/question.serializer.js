import { absolutizeHtml } from '#Libs/urls.js';

// Serializadores de pregunta.
//
// Regla que no se negocia: el enunciado que viaja en un listado, una practica o
// un examen en curso NUNCA lleva `rpta`, `resolution`, `options_answers` ni
// `total_answers`. En una respuesta JSON serian la clave servida en bandeja.
//
// Hay dos defensas: las consultas piden solo los campos publicos (proyeccion) y
// este serializador copia campo a campo (lista blanca), de modo que añadir un
// campo a la proyeccion por descuido no lo expone.

/** `options` puede ser un Map (documento) o un objeto plano (lean / aggregate). */
export const optionEntries = (options) => {
    if (!options) return [];
    const entries = options instanceof Map ? [...options.entries()] : Object.entries(options);
    return entries.sort(([a], [b]) => a.localeCompare(b));
};

/** Campos que se piden a Mongo para una pregunta sin respuesta. */
export const PUBLIC_QUESTION_PROJECTION = Object.freeze({
    _id: 1,
    question: 1,
    options: 1,
    area: 1,
    area_id: 1,
    topic: 1,
    difficulty: 1,
    type: 1,
    dependence: 1,
});

const serializeContext = (dependence) => {
    if (!dependence || typeof dependence !== 'object' || !dependence.text) return null;
    return { id: dependence.id ?? null, text: absolutizeHtml(dependence.text) };
};

/** Pregunta tal como la ve quien esta resolviendo: sin respuesta correcta. */
export const serializeQuestion = (question) => ({
    id: question._id,
    question: absolutizeHtml(question.question),
    options: optionEntries(question.options).map(([key, value]) => ({ key, text: absolutizeHtml(value) })),
    area: question.area ?? null,
    area_id: question.area_id ?? null,
    topic: question.topic ?? null,
    difficulty: question.difficulty ?? null,
    type: question.type ?? null,
    // Texto de lectura compartido por varias preguntas (si lo hay).
    context: serializeContext(question.dependence),
});

const readCounter = (counters, key) => {
    if (!counters) return 0;
    const value = counters instanceof Map ? counters.get(key) : counters[key];
    return Number.isFinite(value) ? value : 0;
};

/** Porcentaje de la comunidad por opcion, como lo pinta la web bajo el solucionario. */
export const buildCommunity = (question) => {
    const total = Number.isFinite(question.total_answers) ? question.total_answers : 0;
    return {
        total,
        options: optionEntries(question.options).map(([key]) => {
            const count = readCounter(question.options_answers, key);
            return { key, count, percent: total > 0 ? +((count * 100) / total).toFixed(2) : 0 };
        }),
    };
};

/**
 * Resultado de responder. Aqui SI van la respuesta y la explicacion: el
 * postulante ya se comprometio con una opcion.
 */
export const serializeAnswerResult = ({ question, selected, community }) => ({
    question_id: question._id,
    selected,
    is_correct: Boolean(question.rpta) && question.rpta === selected,
    correct: question.rpta ?? null,
    explanation: question.resolution ? absolutizeHtml(question.resolution) : null,
    community,
});
