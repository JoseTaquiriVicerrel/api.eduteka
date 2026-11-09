import QuestionModel from '#Models/question_model.js';
import ExamModel from '#Models/exam_model.js';
import UserModel from '#Models/user_model.js';
import UserAnswerModel from '#Models/user_answer_model.js';
import { generateHybridSlug } from '#Libs/slug_utils.js';
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
import { OFFICIAL_BANK_FILTER, practicableFilter, resolveArea } from './question.filters.js';

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
export const listQuestions = async ({ area, topic, difficulty, institution, q, page, limit, user = null, client = 'app' }) => {
    const answers = canViewAnswersDirectly(user);
    const areaId = area ? (await resolveArea(area))._id : null;
    const filter = practicableFilter({ areaId, topic, difficulty, institution, requireKey: client !== 'web' });

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
    const base = practicableFilter({ areaId, institution, withResolution });

    const [topics, totalQuestions] = await Promise.all([
        QuestionModel.aggregate([
            { $match: { ...base, topic: { $exists: true, $nin: [null, ''] } } },
            { $group: { _id: '$topic', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
        ]).exec(),
        // Mismo filtro que `GET /areas`: los temas solo cubren las preguntas que tienen tema.
        QuestionModel.countDocuments(base).exec(),
    ]);

    const items = topics.map((item) => ({ topic: item._id, count: item.count }));
    const withTopic = items.reduce((sum, item) => sum + item.count, 0);

    return { items, meta: { total_questions: totalQuestions, with_topic: withTopic, without_topic: totalQuestions - withTopic } };
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

    // Solo bloquea mientras el anterior siga sin revisar (igual que el monolito): resuelto o rechazado,
    // el usuario puede volver a reportar si el error persiste.
    const previous = await QuestionReportModel.exists({ question_id: questionId, user_id: userId, type, status: 'Pendiente' });
    if (previous) throw ApiError.conflict('Ya registraste un reporte de este tipo sobre esta pregunta, y aún está pendiente de revisión.');

    const report = await QuestionReportModel.create({
        question_id: questionId,
        user_id: userId,
        type,
        description: description.trim(),
    });

    return { id: report._id, status: report.status };
};

// --- Detalle por URL (solo web) ----------------------------------------------

const EXAM_FIELDS = { title: 1, slug: 1, image_post: 1, institution: 1 };

// Resuelve /preguntas/<area>/<uid> y las URLs antiguas que siguen indexadas, igual que
// detailQuestionController del monolito: uid o slug completo, slug de una pieza, o _id. Solo el banco
// oficial: `uid` son 6 caracteres enumerables y no puede dar las preguntas privadas de un docente.
// El `$type` del slug es para que Mongo use el indice parcial.
const findByPath = async (parts) => {
    if (parts.length === 2) {
        const [part1, part2] = parts;
        return QuestionModel.findOne({
            $or: [{ uid: part2 }, { slug: { $eq: `${part1}/${part2}`, $type: 'string' } }],
            ...OFFICIAL_BANK_FILTER,
        }).lean().exec();
    }
    const [part1] = parts;
    return (await QuestionModel.findOne({ slug: { $eq: part1, $type: 'string' }, ...OFFICIAL_BANK_FILTER }).lean().exec())
        ?? QuestionModel.findOne({ _id: part1, ...OFFICIAL_BANK_FILTER }).lean().exec();
};

const findExam = (question) => {
    if (question.exam) return ExamModel.findOne({ title: question.exam }, EXAM_FIELDS).lean().exec();
    const first = question.iexam?.[0]?.id_exam;
    return first ? ExamModel.findById(first, EXAM_FIELDS).lean().exec() : null;
};

/**
 * Pagina publica de una pregunta. Devuelve `canonical` (la URL buena: si no coincide con la pedida, la
 * web redirige), la pregunta, su examen, autor y fuente, y la respuesta previa del usuario. A diferencia
 * de GET /preguntas/:id sirve tambien las verificadas sin clave (`can_answer: false`).
 */
export const getQuestionByPath = async (path, user = null) => {
    const parts = String(path ?? '').split('/').filter(Boolean);
    if (parts.length < 1 || parts.length > 2) throw ApiError.notFound('No encontramos esa pregunta.');

    const question = await findByPath(parts);
    if (!question) throw ApiError.notFound('No encontramos esa pregunta.');

    const answers = canViewAnswersDirectly(user);
    const canonical = question.uid ? generateHybridSlug(question.area, question.uid) : (question.slug ?? parts.join('/'));

    const [exam, author, previous] = await Promise.all([
        findExam(question),
        question.created_by ? UserModel.findById(question.created_by, { username: 1 }).lean().exec() : null,
        user && !answers ? UserAnswerModel.findOne({ question_id: question._id, user_id: user._id }).lean().exec() : null,
    ]);

    const hasKey = Boolean(question.rpta);
    const community = buildCommunity(question);
    const serialized = serializerFor(answers)(question);

    return {
        canonical,
        question: { ...serialized, slug: canonical, created_by: author?.username ?? null, source: question.source ?? 'Web' },
        can_answer: Boolean(question.verified) && hasKey,
        community: answers || previous ? community : null,
        my_answer: previous && hasKey
            ? serializeAnswerResult({ question, selected: previous.answer, community })
            : previous ? { selected: previous.answer } : null,
        exam: exam
            ? { title: exam.title ?? null, slug: exam.slug ?? null, image_post: exam.image_post ?? null, institution_image: exam.institution?.image ?? null }
            : null,
    };
};

// --- Mis reportes -------------------------------------------------------------

const plainSummary = (html) => {
    const text = String(html ?? '').replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
    return text.length > 100 ? `${text.slice(0, 100)}...` : text;
};

/** Reportes del usuario, el mas reciente primero (hasta 100), con un resumen de la pregunta. */
export const listMyReports = async (userId) => {
    const reports = await QuestionReportModel.find({ user_id: userId }).sort({ created_at: -1 }).limit(100).lean().exec();
    const questions = await QuestionModel.find(
        { _id: { $in: [...new Set(reports.map((report) => report.question_id))] } },
        { question: 1, slug: 1 },
    ).lean().exec();
    const byId = new Map(questions.map((question) => [question._id, question]));

    return reports.map((report) => {
        const question = byId.get(report.question_id);
        return {
            id: report._id,
            type: report.type,
            status: report.status,
            description: report.description,
            admin_note: report.adminNote ?? null,
            created_at: report.created_at ?? null,
            reviewed_at: report.reviewed_at ?? null,
            question: question ? { id: question._id, slug: question.slug ?? null, summary: plainSummary(question.question) } : null,
        };
    });
};
