/**
 * Constructores de los snapshots desnormalizados que se incrustan en examenes y
 * simulacros.
 *
 * La pregunta canonica vive en la coleccion `questions`; el examen o simulacro
 * guarda ademas una copia dentro de `general_items` / `areas[K].items` /
 * `areas[K].questions`. Estos son los unicos sitios donde se decide que campos
 * viajan en esa copia.
 *
 * Modulo hoja a proposito: no importa modelos ni servicios, para que lo puedan
 * usar `exam-process.service.js`, `simulacrum_assembler.service.js` y
 * `question_sync.service.js` sin crear ciclos de importacion.
 */

const cleanResolution = (resolution) => (resolution === '<p><br></p>' ? null : resolution);
const cleanSource = (source) => (source === '--' ? null : source);

export const questionItemExam = (question) => ({
    id: question._id,
    itype: 'question',
    topic: question.topic,
    area: question.area,
    rpta: question.rpta,
    slug: question.slug,
    question: question.question,
    resolution: cleanResolution(question.resolution),
    source: cleanSource(question.source),
    verified: question.verified,
    state: question.state,
    n: question.n,
    options: question.options,
    type_correction: question.type_correction,
    is_ai_solved: question.is_ai_solved,
    needs_manual_review: question.needs_manual_review
});

export const blockItemExam = (block) => ({
    id: block._id ?? block.id,
    itype: 'block',
    title: block.title,
    type: block.type,
    text: block.text,
    state: block.state,
    verified: block.verified
});

export const questionItemSimulacrum = (question) => ({
    id: question._id,
    itype: 'question',
    topic: question.topic,
    area: question.area,
    rpta: question.rpta,
    slug: question.slug,
    question: question.question,
    resolution: cleanResolution(question.resolution),
    source: cleanSource(question.source),
    verified: question.verified,
    state: question.state,
    n: question.n,
    options: question.options
});

// Sincrona a proposito: la version anterior era `async` sin necesidad y en
// simulacrum.process.controllers.js:725 se llamaba sin `await`, guardando una
// Promise (que Mongoose serializaba como {}) dentro de `general_items`.
export const blockItemSimulacrum = (block) => ({
    id: block._id ?? block.id,
    itype: 'block',
    title: block.title,
    type: block.type,
    text: block.text,
    state: block.state,
    verified: block.verified
});
