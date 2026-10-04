import QuestionModel from '#Models/question_model.js';
import QuestionReportModel from '#Models/question_report_model.js';
import { ApiError } from '#Libs/api_error.js';
import { setNX } from '#Libs/kv.js';
import { canViewAnswersDirectly } from '#Libs/capabilities.js';
import { skipOf } from '#Libs/paginate.js';
import {
    buildCommunity, optionEntries, projectionFor, serializeAnswerResult, serializerFor,
} from '#Serializers/question.serializer.js';
import { assertQuota, consumeQuota } from './answer.quota.js';
import { recordAnswers } from './answer.recorder.js';
import { practicableFilter, resolveArea } from './question.filters.js';

// --- Listado ----------------------------------------------------------------

const MAX_SEARCH_LENGTH = 120;

// Texto de busqueda en una sola linea, sin caracteres de control y acotado. Mismo
// criterio que cleanSearchText del monolito.
const cleanSearchText = (value) => String(value ?? '')
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);

// `user` puede ser null (visitante): solo las cuentas con view_answers_directly reciben la clave.
export const listQuestions = async ({ area, topic, difficulty, institution, q, page, limit, user = null }) => {
    const answers = canViewAnswersDirectly(user);
    const areaId = area ? (await resolveArea(area))._id : null;
    const filter = practicableFilter({ areaId, topic, difficulty, institution });

    // Busqueda de texto: usa el indice `topic_text_question_text` de la coleccion,
    // que existe en produccion aunque ningun schema lo declare.
    const search = cleanSearchText(q);
    if (search) filter.$text = { $search: search };

    const projection = search ? { ...projectionFor(answers), score: { $meta: 'textScore' } } : projectionFor(answers);
    // Orden estable: sin busqueda, lo mas reciente primero; con busqueda, por relevancia.
    const sort = search ? { score: { $meta: 'textScore' }, _id: 1 } : { created_at: -1, _id: 1 };

    const [items, total] = await Promise.all([
        QuestionModel.find(filter, projection).sort(sort).skip(skipOf({ page, limit })).limit(limit).lean().exec(),
        QuestionModel.countDocuments(filter).exec(),
    ]);

    return { items: items.map(serializerFor(answers)), total, answers_visible: answers };
};

export const getTopics = async ({ area, institution = null, withResolution = false }) => {
    const { _id: areaId } = await resolveArea(area);

    const topics = await QuestionModel.aggregate([
        { $match: { ...practicableFilter({ areaId, institution, withResolution }), topic: { $exists: true, $nin: [null, ''] } } },
        { $group: { _id: '$topic', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
    ]).exec();

    return topics.map((item) => ({ topic: item._id, count: item.count }));
};

export const getQuestion = async (id, user = null) => {
    const answers = canViewAnswersDirectly(user);
    const question = await QuestionModel.findOne({ _id: id, ...practicableFilter() }, projectionFor(answers)).lean().exec();
    if (!question) throw ApiError.notFound('No encontramos esa pregunta.');
    return serializerFor(answers)(question);
};

// --- Responder --------------------------------------------------------------

/**
 * Registra la respuesta y devuelve la correccion. La regla de "una vez por usuario
 * y pregunta" y los contadores atomicos viven en answer.recorder.js; el cupo
 * diario en answer.quota.js.
 */
export const answerQuestion = async ({ user, questionId, selected: rawSelected }) => {
    const selected = rawSelected.trim().toUpperCase();

    const question = await QuestionModel.findOne(
        { _id: questionId, ...practicableFilter() },
        { options: 1, rpta: 1, resolution: 1 },
    ).lean().exec();
    if (!question) throw ApiError.notFound('No encontramos esa pregunta.');

    const keys = optionEntries(question.options).map(([key]) => key);
    if (!keys.includes(selected)) {
        throw ApiError.validation([{ field: 'selected', message: `Debe ser una de las alternativas: ${keys.join(', ')}.` }]);
    }

    // Doble toque: la segunda peticion identica espera a que termine la primera.
    if (!(await setNX(`answer-lock:${user._id}:${questionId}`, 2))) {
        throw ApiError.conflict('Tu respuesta anterior aún se está procesando.');
    }

    const { created } = await recordAnswers({
        userId: user._id,
        items: [{ questionId, keys, selected }],
        beforeWrite: ({ created: fresh }) => assertQuota(user, fresh),
    });
    await consumeQuota(user, created);

    const counters = await QuestionModel.findById(questionId, { options: 1, options_answers: 1, total_answers: 1 }).lean().exec();

    return serializeAnswerResult({ question, selected, community: buildCommunity(counters) });
};

// --- Reportar ---------------------------------------------------------------

export const reportQuestion = async ({ userId, questionId, type, description }) => {
    const exists = await QuestionModel.exists({ _id: questionId, ...practicableFilter() });
    if (!exists) throw ApiError.notFound('No encontramos esa pregunta.');

    const previous = await QuestionReportModel.exists({ question_id: questionId, user_id: userId, type });
    if (previous) throw ApiError.conflict('Ya registraste un reporte de este tipo sobre esta pregunta.');

    const report = await QuestionReportModel.create({
        question_id: questionId,
        user_id: userId,
        type,
        description: description.trim(),
    });

    return { id: report._id, status: report.status };
};
