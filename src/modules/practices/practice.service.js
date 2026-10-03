import QuestionModel from '#Models/question_model.js';
import PracticeAttemptModel from '#Models/practice_attempt_model.js';
import UserQuestionsListModel from '#Models/user_questions_list_model.js';
import { ApiError } from '#Libs/api_error.js';
import { del, setNX } from '#Libs/kv.js';
import { skipOf } from '#Libs/paginate.js';
import { absolutizeHtml } from '#Libs/urls.js';
import { PUBLIC_QUESTION_PROJECTION, optionEntries, serializeQuestion } from '#Serializers/question.serializer.js';
import { invalidateProgress } from '#Modules/progress/progress.cache.js';
import { assertQuota, consumeQuota, remainingQuota } from '#Modules/questions/answer.quota.js';
import { recordAnswers } from '#Modules/questions/answer.recorder.js';
import { practicableFilter, resolveArea } from '#Modules/questions/question.filters.js';

// Practicas: por area (se generan al vuelo) y guardadas (listas publicadas).

const REPLAY_WINDOW_MS = 10 * 60 * 1000;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- Practica por area ------------------------------------------------------

/**
 * Genera una tanda al azar ($sample): dos sesiones seguidas del mismo tema no
 * repiten las mismas preguntas. Las preguntas salen sin respuesta ni explicacion.
 *
 * Con el plan gratuito limitado, la tanda se recorta al cupo diario que queda; con
 * el cupo agotado no se genera (403).
 */
export const generateAreaPractice = async ({ user, area, topic, difficulty, institution, count, withResolution }) => {
    const { _id: areaId } = await resolveArea(area);

    const remaining = await remainingQuota(user);
    if (remaining === 0) await assertQuota(user, 1);
    const size = Math.min(count, remaining);

    const docs = await QuestionModel.aggregate([
        { $match: practicableFilter({ areaId, topic, difficulty, institution, withResolution }) },
        { $sample: { size } },
        { $project: PUBLIC_QUESTION_PROJECTION },
    ]).exec();

    return {
        questions: docs.map(serializeQuestion),
        meta: {
            total: docs.length,
            requested: count,
            quota_remaining: Number.isFinite(remaining) ? remaining : null,
        },
    };
};

// --- Correccion -------------------------------------------------------------

const normalizeSelected = (value) => (typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null);

// Misma estructura => misma cadena, sin importar el orden de las claves.
const canonical = (answers) => JSON.stringify(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Corrige en el servidor (el cliente dice que marco, no si acerto), registra las
 * respuestas en la comunidad y guarda el `PracticeAttempt`.
 *
 * - Idempotente: reenviar el mismo cierre en 10 min (el cliente reintenta tras un
 *   corte de red) devuelve el mismo intento en vez de duplicarlo.
 * - Una pregunta que ya no se sirve (se desverifico, cambio de area) cuenta como
 *   no respondida; si NINGUNA se sirve, el cierre es invalido (422).
 */
const gradeAndSave = async ({ user, scope, attemptFields, filter, questionIds, answers, time }) => {
    const extra = Object.keys(answers).filter((id) => !questionIds.includes(id));
    if (extra.length > 0) {
        throw ApiError.validation([{ field: 'answers', message: 'Hay respuestas de preguntas que no pertenecen a esta práctica.' }]);
    }

    const questions = await QuestionModel
        .find({ _id: { $in: questionIds }, ...filter }, { options: 1, rpta: 1, resolution: 1 })
        .lean()
        .exec();
    const byId = new Map(questions.map((question) => [question._id, question]));

    if (byId.size === 0) {
        throw ApiError.validation([{ field: 'question_ids', message: 'Ninguna de las preguntas se puede practicar.' }]);
    }

    let correct = 0;
    let incorrect = 0;
    let notAnswered = 0;
    const review = [];
    const normalized = {};
    const toRecord = [];

    for (const id of questionIds) {
        const question = byId.get(id);
        const selected = question ? normalizeSelected(answers[id]) : null;
        normalized[id] = selected;

        if (!question || selected === null) {
            notAnswered += 1;
            review.push({
                question_id: id,
                selected: null,
                correct: question?.rpta ?? null,
                is_correct: false,
                explanation: question?.resolution ? absolutizeHtml(question.resolution) : null,
            });
            continue;
        }

        const isCorrect = Boolean(question.rpta) && question.rpta === selected;
        if (isCorrect) correct += 1;
        else incorrect += 1;

        const keys = optionEntries(question.options).map(([key]) => key);
        // Una letra que la pregunta no tiene cuenta como incorrecta pero no vota.
        if (keys.includes(selected)) toRecord.push({ questionId: id, keys, selected });

        review.push({
            question_id: id,
            selected,
            correct: question.rpta ?? null,
            is_correct: isCorrect,
            explanation: question.resolution ? absolutizeHtml(question.resolution) : null,
        });
    }

    const summary = { total: questionIds.length, correct, incorrect, not_answered: notAnswered, time, review };

    // Dos cierres simultaneos del mismo usuario y practica (doble toque) no deben
    // duplicar el intento: el segundo espera a reintentar, y entonces lo recibe
    // como reenvio. El bloqueo se libera siempre al terminar.
    const lockKey = `finalize-lock:${user._id}:${scope}`;
    if (!(await setNX(lockKey, 10))) {
        throw ApiError.conflict('Tu práctica anterior aún se está guardando.');
    }

    try {
        // Reintento del mismo cierre: se devuelve el intento ya guardado.
        const recent = await PracticeAttemptModel
            .find({ user_id: user._id, ...attemptFields, created_at: { $gte: new Date(Date.now() - REPLAY_WINDOW_MS) } }, { answers: 1, total_questions: 1 })
            .sort({ created_at: -1 })
            .limit(5)
            .lean()
            .exec();
        const replayed = recent.find((attempt) => attempt.total_questions === questionIds.length && canonical(attempt.answers ?? {}) === canonical(normalized));
        if (replayed) return { replay: true, result: { attempt_id: replayed._id, ...summary } };

        const { created } = await recordAnswers({
            userId: user._id,
            items: toRecord,
            beforeWrite: ({ created: fresh }) => assertQuota(user, fresh),
        });
        await consumeQuota(user, created);

        const attempt = await PracticeAttemptModel.create({
            user_id: user._id,
            ...attemptFields,
            answers: normalized,
            time,
            total_questions: questionIds.length,
            questions_correct: correct,
            questions_incorrect: incorrect,
            questions_not_answered: notAnswered,
        });

        await invalidateProgress(user._id);

        return { replay: false, result: { attempt_id: attempt._id, ...summary } };
    } finally {
        await del(lockKey);
    }
};

export const finalizeAreaPractice = async ({ user, body }) => {
    const { _id: areaId } = await resolveArea(body.area);

    return gradeAndSave({
        user,
        scope: `area:${areaId}`,
        attemptFields: { source: 'area', area_id: areaId, topic: body.topic ?? null },
        filter: practicableFilter({ areaId }),
        questionIds: body.question_ids,
        answers: body.answers,
        time: body.time,
    });
};

// --- Practicas guardadas (listas publicadas) --------------------------------

// Una lista es visible si es publica o es del propio usuario.
const findVisiblePractice = async (slug, user) => {
    const practice = await UserQuestionsListModel.findOne({ slug }).lean().exec();
    if (!practice) throw ApiError.notFound('No encontramos esa práctica.');
    if (practice.public !== true && (!user || practice.user !== user._id)) {
        throw ApiError.notFound('No encontramos esa práctica.');
    }
    return practice;
};

const serializeAreas = (areas) =>
    (Array.isArray(areas) ? areas : []).map((area) => ({ name: area?.name ?? null, count: area?.count ?? 0 }));

export const listPractices = async ({ area, q, page, limit }) => {
    const filter = { slug: { $exists: true }, public: true };

    const search = String(q ?? '').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (search) filter.name = new RegExp(escapeRegex(search), 'i');

    if (area) {
        const { _id: areaId, name } = await resolveArea(area);
        // `areas` de la lista guarda el TEXTO del area de cada pregunta, que tiene
        // variantes ("QUÍMICA", "Química"): se buscan todas las que usa ese area.
        const variants = await QuestionModel.distinct('area', { area_id: areaId });
        filter.areas = { $elemMatch: { name: { $in: [...new Set([name, ...variants.filter(Boolean)])] } } };
    }

    const [items, total] = await Promise.all([
        UserQuestionsListModel
            .find(filter, { name: 1, slug: 1, description: 1, areas: 1, count_questions: 1, favorites: 1 })
            .sort({ created_at: -1, _id: 1 })
            .skip(skipOf({ page, limit }))
            .limit(limit)
            .lean()
            .exec(),
        UserQuestionsListModel.countDocuments(filter).exec(),
    ]);

    return {
        total,
        items: items.map((practice) => ({
            id: practice._id,
            name: practice.name ?? null,
            slug: practice.slug,
            description: practice.description ?? null,
            count_questions: practice.count_questions ?? 0,
            favorites: practice.favorites ?? 0,
            areas: serializeAreas(practice.areas),
        })),
    };
};

// Preguntas de la lista que todavia se pueden practicar, en el orden de la lista.
const loadPracticeQuestions = async (practice, projection) => {
    const ids = Array.isArray(practice.questions) ? practice.questions : [];
    const docs = await QuestionModel.find({ _id: { $in: ids }, ...practicableFilter() }, projection).lean().exec();
    const byId = new Map(docs.map((doc) => [doc._id, doc]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
};

export const getPractice = async ({ slug, user }) => {
    const practice = await findVisiblePractice(slug, user);
    const questions = await loadPracticeQuestions(practice, PUBLIC_QUESTION_PROJECTION);

    return {
        id: practice._id,
        name: practice.name ?? null,
        slug: practice.slug,
        description: practice.description ?? null,
        count_questions: questions.length,
        areas: serializeAreas(practice.areas),
        questions: questions.map(serializeQuestion),
    };
};

export const finalizePractice = async ({ user, slug, body }) => {
    const practice = await findVisiblePractice(slug, user);
    const questions = await loadPracticeQuestions(practice, { _id: 1 });

    return gradeAndSave({
        user,
        scope: `lista:${practice._id}`,
        attemptFields: { source: 'lista', practice_id: practice._id, practice_slug: practice.slug },
        filter: practicableFilter(),
        questionIds: questions.map((question) => question._id),
        answers: body.answers,
        time: body.time,
    });
};
