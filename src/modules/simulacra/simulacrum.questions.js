import BlockModel from '#Models/block_model.js';
import ProspectModel from '#Models/prospect_model.js';
import QuestionModel from '#Models/question_model.js';
import { QUESTION_FIELDS, completeQuestion, isIncompleteQuestion } from '#Libs/simulacrum_questions.js';
import { optionEntries } from '#Serializers/question.serializer.js';
import { isGeneral } from './simulacrum.state.js';

// Preguntas de un simulacro para un postulante.
//
// El simulacro guarda un SNAPSHOT de sus preguntas (`general_items` o
// `areas[K].questions`), y ese snapshot no siempre esta completo (la ingesta de
// prospectos guarda solo la referencia {itype, id}). Servir, calificar y mostrar el
// solucionario salen de la MISMA lista, ya completada contra `questions`: asi lo que
// el postulante ve es exactamente lo que se corrige.

const isReading = (item) => ['block', 'bloque', 'reading_section'].includes(item?.itype);

/** De donde salen las preguntas: el banco general del simulacro o las del area elegida. */
export const questionSource = async (simulacrum, area) => {
    const fromArea = () => simulacrum.areas?.[area]?.questions ?? [];
    const fromGeneral = () => simulacrum.general_items ?? [];

    if (simulacrum.prospect) {
        const prospect = await ProspectModel.findById(simulacrum.prospect).lean().exec();
        return { prospect, items: prospect?.exam_unique ? fromGeneral() : fromArea() };
    }

    // `general`: las mismas preguntas para todos (general_items). Si el banco general
    // esta vacio se cae a las del area.
    const items = isGeneral(simulacrum) && fromGeneral().length > 0 ? fromGeneral() : fromArea();
    return { prospect: null, items };
};

/** Normaliza `options` (objeto {A:..} o arreglo ya mapeado [{opt, option}]) a [{key, text}]. */
const normalizeOptions = (options) => {
    if (Array.isArray(options)) return options.map((option) => ({ key: option.opt, text: option.option }));
    return optionEntries(options).map(([key, text]) => ({ key, text }));
};

/**
 * Lista completa, con clave. NO se envia tal cual al cliente: `toClientItems`
 * quita la respuesta.
 *
 * @returns {Promise<{ prospect: object|null, items: object[] }>}
 */
export const loadQuestionSet = async (simulacrum, area) => {
    const { prospect, items: snapshot } = await questionSource(simulacrum, area);
    const relevant = snapshot.filter((item) => item?.itype === 'question' || isReading(item));

    const questionIds = relevant.filter((item) => item.itype === 'question').map((item) => item.id);
    // En prospectos la canonica manda; en el resto solo rellena huecos del snapshot.
    const canonicalFirst = Boolean(simulacrum.prospect);
    const needsCanonical = canonicalFirst ? questionIds : relevant.filter(isIncompleteQuestion).map((item) => item.id);

    const canonical = needsCanonical.length
        ? await QuestionModel.find({ _id: { $in: needsCanonical } }, Object.fromEntries(QUESTION_FIELDS.map((field) => [field, 1]))).lean().exec()
        : [];
    const canonicalById = new Map(canonical.map((doc) => [doc._id, doc]));

    const blockIds = relevant.filter((item) => isReading(item) && !(item.text ?? item.texto) && item.id).map((item) => item.id);
    const blocks = blockIds.length
        ? await BlockModel.find({ _id: { $in: blockIds } }, { title: 1, text: 1, texto: 1, area: 1 }).lean().exec()
        : [];
    const blockById = new Map(blocks.map((doc) => [doc._id, doc]));

    const items = relevant.map((item) => {
        if (isReading(item)) {
            const block = blockById.get(item.id);
            return {
                kind: 'reading',
                id: item.id,
                title: item.title ?? block?.title ?? null,
                text: item.text ?? item.texto ?? block?.text ?? block?.texto ?? '',
                area: item.area ?? block?.area ?? null,
            };
        }

        const merged = canonicalById.has(item.id) ? completeQuestion(item, canonicalById.get(item.id), canonicalFirst) : item;
        return {
            kind: 'question',
            id: item.id,
            area: merged.area ?? null,
            topic: merged.topic ?? null,
            question: merged.question ?? '',
            options: normalizeOptions(merged.options),
            rpta: merged.rpta ?? null,
            resolution: merged.resolution ?? null,
        };
    });

    return { prospect, items };
};

/** Solo los ids de las preguntas (para validar el autoguardado) sin cargar enunciados ni opciones. */
export const questionIdSet = async (simulacrum, area) => {
    const { items } = await questionSource(simulacrum, area);
    return new Set(items.filter((item) => item?.itype === 'question').map((item) => item.id));
};
