import { randomBytes, randomUUID } from 'node:crypto';
import QuestionModel from '#Models/question_model.js';
import UserQuestionsListModel from '#Models/user_questions_list_model.js';
import { ApiError } from '#Libs/api_error.js';
import { canSeeSolutions, isPremium } from '#Libs/capabilities.js';
import { limitsFor } from '#Libs/plan_limits.js';
import { convertSlug, groupByAndCount } from '#Libs/functions.js';
import { buildListPdf } from '#Libs/list_pdf.js';
import { skipOf } from '#Libs/paginate.js';
import { PUBLIC_QUESTION_PROJECTION, optionEntries, serializeQuestion } from '#Serializers/question.serializer.js';
import { practicableFilter } from '#Modules/questions/question.filters.js';

// Listas personales de preguntas (UserQuestionsList del propio usuario). Toda
// consulta filtra por `user` = id del token: una lista ajena es un 404.
//
// Reglas del monolito: hasta 30 preguntas (50 con suscripcion vigente, o el tope propio del
// plan: #Libs/plan_limits.js); publicar
// exige al menos 10; el slug es nombre + sufijo aleatorio y cambia al renombrar.

const MIN_QUESTIONS_PUBLIC = 10;
const MAX_LISTS = 100;


const makeSlug = (name) => `${convertSlug(name) || 'lista'}-${randomBytes(6).toString('hex')}`;

const iso = (value) => (value ? new Date(value).toISOString() : null);

const serializeList = (list, extra = {}) => ({
    id: list._id,
    name: list.name ?? null,
    slug: list.slug ?? null,
    description: list.description ?? null,
    public: list.public === true,
    count_questions: Array.isArray(list.questions) ? list.questions.length : (list.count_questions ?? 0),
    areas: (Array.isArray(list.areas) ? list.areas : []).map((area) => ({ name: area?.name ?? null, count: area?.count ?? 0 })),
    created_at: iso(list.created_at),
    updated_at: iso(list.updated_at),
    ...extra,
});

const findOwn = async (id, user) => {
    const list = await UserQuestionsListModel.findOne({ _id: id, user: user._id }).lean().exec();
    if (!list) throw ApiError.notFound('No encontramos esa lista.');
    return list;
};

/** Las preguntas deben existir y poder servirse; si no, 422 con los ids que fallan. */
const loadServable = async (ids, field) => {
    const docs = await QuestionModel.find({ _id: { $in: ids }, ...practicableFilter() }, { _id: 1, area: 1 }).lean().exec();
    if (docs.length !== ids.length) {
        const found = new Set(docs.map((doc) => doc._id));
        const missing = ids.filter((id) => !found.has(id));
        throw ApiError.validation([{ field, message: `Estas preguntas no existen o no están disponibles: ${missing.join(', ')}.` }]);
    }
    return docs;
};

const derivedFields = (docs, ids) => {
    const byId = new Map(docs.map((doc) => [doc._id, doc]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    return {
        areas: groupByAndCount(ordered.filter((doc) => doc.area), 'area'),
        count_questions: ids.length,
    };
};

const assertCanHold = (user, count) => {
    const max = limitsFor(user).list_questions;
    if (count <= max) return;
    // Sin plan activo el tope es el base: 403 para que el cliente ofrezca suscribirse. Con plan, 422.
    if (!isPremium(user)) {
        throw ApiError.subscriptionRequired(`Una lista admite hasta ${max} preguntas sin suscripción. Con un plan, hasta ${limitsFor({ ...user, suscription: { status: 'activo' } }).list_questions}.`);
    }
    throw ApiError.validation([{ field: 'questions', message: `La lista de preguntas debe tener como máximo ${max} preguntas.` }]);
};

const assertPublishable = (count) => {
    if (count < MIN_QUESTIONS_PUBLIC) {
        throw ApiError.validation([{ field: 'public', message: `Una lista pública necesita al menos ${MIN_QUESTIONS_PUBLIC} preguntas.` }]);
    }
};

// --- Consultas --------------------------------------------------------------

export const listOwn = async ({ user, questionId, page, limit }) => {
    const filter = { user: user._id };
    const [items, total] = await Promise.all([
        UserQuestionsListModel.find(filter).sort({ created_at: -1, _id: 1 }).skip(skipOf({ page, limit })).limit(limit).lean().exec(),
        UserQuestionsListModel.countDocuments(filter).exec(),
    ]);

    return {
        total,
        items: items.map((list) => serializeList(list, questionId ? { contains: (list.questions ?? []).includes(questionId) } : {})),
    };
};

export const getOwn = async ({ user, id }) => {
    const list = await findOwn(id, user);
    const ids = list.questions ?? [];

    const docs = ids.length
        ? await QuestionModel.find({ _id: { $in: ids }, ...practicableFilter() }, PUBLIC_QUESTION_PROJECTION).lean().exec()
        : [];
    const byId = new Map(docs.map((doc) => [doc._id, doc]));
    const served = ids.map((questionId) => byId.get(questionId)).filter(Boolean);

    return serializeList(list, {
        question_ids: ids,
        // Las que ya no se sirven (se desverificaron) siguen en `question_ids` pero no aparecen aqui.
        questions: served.map(serializeQuestion),
    });
};

// --- Escritura --------------------------------------------------------------

export const createList = async ({ user, body }) => {
    if ((await UserQuestionsListModel.countDocuments({ user: user._id }).exec()) >= MAX_LISTS) {
        throw ApiError.validation([{ field: 'name', message: `Puedes tener como máximo ${MAX_LISTS} listas.` }]);
    }

    const ids = body.question_ids ?? [];
    assertCanHold(user, ids.length);
    const docs = ids.length ? await loadServable(ids, 'question_ids') : [];

    const list = await UserQuestionsListModel.create({
        _id: randomUUID(),
        user: user._id,
        name: body.name.trim(),
        description: body.description?.trim() ?? '',
        slug: makeSlug(body.name),
        public: false,
        questions: ids,
        ...derivedFields(docs, ids),
    });

    return serializeList(list.toObject());
};

export const updateList = async ({ user, id, body }) => {
    const list = await findOwn(id, user);
    const set = {};

    if (body.name !== undefined) {
        set.name = body.name.trim();
        // Renombrar cambia la URL publica de la lista.
        if (set.name !== list.name || !list.slug) set.slug = makeSlug(set.name);
    }
    if (body.description !== undefined) set.description = body.description.trim();

    let ids = list.questions ?? [];
    if (body.questions !== undefined) {
        ids = body.questions;
        assertCanHold(user, ids.length);
        const docs = ids.length ? await loadServable(ids, 'questions') : [];
        Object.assign(set, { questions: ids, ...derivedFields(docs, ids) });
    }

    const willBePublic = body.public ?? list.public === true;
    if (body.public !== undefined) set.public = body.public;
    if (willBePublic) assertPublishable(ids.length);
    if (willBePublic && !set.slug && !list.slug) set.slug = makeSlug(set.name ?? list.name ?? 'lista');

    await UserQuestionsListModel.updateOne({ _id: id, user: user._id }, { $set: set }).exec();
    return getOwn({ user, id });
};

export const deleteList = async ({ user, id }) => {
    const { deletedCount } = await UserQuestionsListModel.deleteOne({ _id: id, user: user._id }).exec();
    if (!deletedCount) throw ApiError.notFound('No encontramos esa lista.');
};

export const addQuestion = async ({ user, id, questionId }) => {
    const list = await findOwn(id, user);
    const ids = list.questions ?? [];

    if (ids.includes(questionId)) throw ApiError.conflict('Esa pregunta ya está en la lista.');
    assertCanHold(user, ids.length + 1);
    await loadServable([questionId], 'question_id');

    // $addToSet evita duplicados aunque lleguen dos peticiones a la vez.
    await UserQuestionsListModel.updateOne({ _id: id, user: user._id }, { $addToSet: { questions: questionId } }).exec();
    return refreshDerived(user, id);
};

export const removeQuestion = async ({ user, id, questionId }) => {
    const list = await findOwn(id, user);
    const ids = list.questions ?? [];

    if (!ids.includes(questionId)) throw ApiError.notFound('Esa pregunta no está en la lista.');
    if (list.public === true && ids.length - 1 < MIN_QUESTIONS_PUBLIC) {
        throw ApiError.validation([{ field: 'public', message: `Una lista pública necesita al menos ${MIN_QUESTIONS_PUBLIC} preguntas: despublícala antes de quitar esta.` }]);
    }

    await UserQuestionsListModel.updateOne({ _id: id, user: user._id }, { $pull: { questions: questionId } }).exec();
    return refreshDerived(user, id);
};

// Recalcula `areas` y `count_questions` a partir del contenido actual.
const refreshDerived = async (user, id) => {
    const list = await findOwn(id, user);
    const ids = list.questions ?? [];
    const docs = ids.length ? await QuestionModel.find({ _id: { $in: ids } }, { _id: 1, area: 1 }).lean().exec() : [];

    await UserQuestionsListModel.updateOne({ _id: id, user: user._id }, { $set: derivedFields(docs, ids) }).exec();
    return serializeList({ ...list, ...derivedFields(docs, ids) });
};

/**
 * PDF de TEXTO de una lista propia (ver #Libs/list_pdf.js para sus limites). Con
 * `includeAnswers` añade la clave de respuestas, solo a suscriptores y docentes: si no, el PDF
 * seria una via para saltarse el cupo diario de respuestas.
 */
export const buildPdf = async ({ user, id, includeAnswers }) => {
    if (includeAnswers && !isPremium(user) && !canSeeSolutions(user)) {
        throw ApiError.subscriptionRequired('La clave de respuestas del PDF es para suscriptores.');
    }

    const list = await findOwn(id, user);
    const ids = list.questions ?? [];
    const docs = ids.length
        ? await QuestionModel.find({ _id: { $in: ids }, ...practicableFilter() }, { question: 1, options: 1, rpta: 1 }).lean().exec()
        : [];
    const byId = new Map(docs.map((doc) => [doc._id, doc]));
    const questions = ids.map((questionId) => byId.get(questionId)).filter(Boolean);

    if (questions.length === 0) throw ApiError.conflict('La lista no tiene preguntas disponibles.');

    const buffer = await buildListPdf({
        title: list.name ?? 'Lista de preguntas',
        description: list.description,
        includeAnswers,
        questions: questions.map((doc) => ({
            question: doc.question,
            options: optionEntries(doc.options).map(([key, text]) => ({ key, text })),
            correct: doc.rpta,
        })),
    });

    return { buffer, filename: `${convertSlug(list.name ?? '') || 'lista-de-preguntas'}.pdf` };
};
