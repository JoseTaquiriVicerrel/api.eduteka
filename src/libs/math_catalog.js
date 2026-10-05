import BlockModel from '#Models/block_model.js';
import ExamModel from '#Models/exam_model.js';
import QuestionModel from '#Models/question_model.js';
import SimulacrumModel from '#Models/simulacrum_model.js';
import { practicableFilter } from '#Modules/questions/question.filters.js';
import { loadQuestionSet } from '#Modules/simulacra/simulacrum.questions.js';
import { classifyFormula, extractFormulas, mathHash } from '#Libs/math_svg.js';

// Que formulas hay en el banco: base de los scripts de precalentamiento y limpieza
// (scripts/warm_math_cache.js, scripts/prune_math_cache.js).
//
// Se recorren las MISMAS fuentes de HTML que la API sirve con ?math=svg:
//   questions  preguntas practicables (pregunta, opciones, resolucion y lectura enlazada)
//   blocks     textos de lectura (los que referencian examenes y simulacros)
//   exams      examenes verificados (banco general y cuadernillos)
//   simulacra  simulacros publicados (banco general y areas)

export const SOURCES = Object.freeze(['questions', 'blocks', 'exams', 'simulacra']);

/** Todo el HTML de un elemento de examen o simulacro (pregunta suelta o lectura). */
const itemFragments = (item) => {
    if (!item || typeof item !== 'object') return [];
    const fragments = [item.question, item.resolution, item.text, item.texto];
    const { options } = item;
    if (Array.isArray(options)) fragments.push(...options.map((option) => (typeof option === 'string' ? option : option?.option)));
    else if (options && typeof options === 'object') fragments.push(...Object.values(options instanceof Map ? Object.fromEntries(options) : options));
    return fragments;
};

const areaItems = (areas, field) => Object.values(areas ?? {}).flatMap((area) => (Array.isArray(area?.[field]) ? area[field] : []));

const EXTRACTORS = {
    questions: (doc) => [...itemFragments(doc), doc.dependence?.text],
    blocks: (doc) => [doc.text, doc.texto],
    exams: (doc) => [...(doc.general_items ?? []), ...areaItems(doc.areas, 'items')].flatMap(itemFragments),
    simulacra: (doc) => [...(doc.general_items ?? []), ...areaItems(doc.areas, 'questions')].flatMap(itemFragments),
};

const QUERIES = {
    questions: () => QuestionModel.find(practicableFilter(), { question: 1, resolution: 1, options: 1, dependence: 1 }),
    blocks: () => BlockModel.find({}, { text: 1, texto: 1 }),
    exams: () => ExamModel.find({ verified: true }, { general_items: 1, areas: 1 }),
    simulacra: ({ slug } = {}) => SimulacrumModel.find(
        { verified: true, state: true, ...(slug ? { slug } : {}) },
        { general_items: 1, areas: 1, prospect: 1, general: 1 },
    ),
};

/**
 * HTML de las preguntas que un simulacro SIRVE de verdad (`loadQuestionSet`, la misma lista
 * que usan iniciar, calificar y el solucionario). En los de prospecto el snapshot son solo
 * referencias {itype, id}: sus formulas viven en `questions`/`blocks` y, sin esto, el primer
 * postulante las veria en LaTeX por el presupuesto de tiempo de ?math=svg.
 */
export const servedFragments = async (simulacrum) => {
    const keys = Object.keys(simulacrum.areas ?? {});
    const fragments = [];
    for (const area of keys.length ? keys : [undefined]) {
        const { items } = await loadQuestionSet(simulacrum, area);
        for (const item of items) {
            fragments.push(item.question, item.resolution, item.text, ...(item.options ?? []).map((option) => option.text));
        }
    }
    return fragments;
};

/** Fragmentos de HTML (solo strings no vacios) de un documento de la fuente. */
export const fragmentsOf = (source, doc) => EXTRACTORS[source](doc).filter((fragment) => typeof fragment === 'string' && fragment.length > 0);

/** Formulas distintas de un fragmento de HTML: [{ tex, mode }]. */
export const scanFormulas = (html) => extractFormulas(html).map((formula) => ({ tex: formula.tex, mode: classifyFormula(html, formula) }));

/**
 * Recorre las fuentes y reune las formulas DISTINTAS (mismo TeX y modo = una sola).
 * @returns {Promise<{ formulas: Map<string, { tex, mode, refs: number, first: string }>, documents: number, fragments: number, occurrences: number }>}
 */
export const collectFormulas = async ({ sources = SOURCES, limit = 0, slug = null, onDocument } = {}) => {
    const formulas = new Map();
    let documents = 0;
    let fragments = 0;
    let occurrences = 0;

    for (const source of sources) {
        let query = QUERIES[source]({ slug }).lean();
        if (limit > 0) query = query.limit(limit);

        for await (const doc of query.cursor()) {
            documents += 1;
            onDocument?.(source, documents);
            const htmlFragments = source === 'simulacra' ? [...fragmentsOf(source, doc), ...(await servedFragments(doc))] : fragmentsOf(source, doc);
            for (const html of htmlFragments.filter((fragment) => typeof fragment === 'string' && fragment.length > 0)) {
                fragments += 1;
                for (const { tex, mode } of scanFormulas(html)) {
                    occurrences += 1;
                    const key = `${mode}\u0000${tex}`;
                    const known = formulas.get(key);
                    if (known) known.refs += 1;
                    else formulas.set(key, { tex, mode, refs: 1, first: `${source}:${doc._id}` });
                }
            }
        }
    }
    return { formulas, documents, fragments, occurrences };
};

/** Hashes que existen para estas formulas con la `version` dada (los archivos que NO se deben borrar). */
export const liveHashes = (formulas, version) => new Set([...formulas.values()].map(({ tex, mode }) => mathHash({ tex, mode, version })));

/**
 * Convierte (o confirma en cache) cada formula. No lanza por una formula mala: la anota.
 * @returns {Promise<{ converted: number, failed: Array<{ tex, mode, first, error }>, ms: number }>}
 */
export const warmFormulas = async (formulas, store, { onProgress } = {}) => {
    const started = Date.now();
    const failed = [];
    let converted = 0;
    let done = 0;

    for (const { tex, mode, first } of formulas.values()) {
        try {
            await store.getAsset({ tex, mode });
            converted += 1;
        } catch (error) {
            failed.push({ tex, mode, first, error: error.message });
        }
        done += 1;
        onProgress?.(done, formulas.size);
    }
    return { converted, failed, ms: Date.now() - started };
};
