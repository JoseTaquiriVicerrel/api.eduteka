import AreaModel from '#Models/area_model.js';
import PracticeAttemptModel from '#Models/practice_attempt_model.js';
import SimulacrumAttemptModel from '#Models/simulacrum_attempt_model.js';
import SimulacrumModel from '#Models/simulacrum_model.js';
import UserQuestionsListModel from '#Models/user_questions_list_model.js';
import UserSimulacrumModel from '#Models/user_simulacrum_model.js';
import { mergeGradedAttempts } from '#Libs/progress_metrics.js';
import { skipOf } from '#Libs/paginate.js';

// Historial de intentos del usuario: practicas (PracticeAttempt) y simulacros
// (UserSimulacrum = intento vivo, SimulacrumAttempt = archivo de intentos viejos).

// Sin `answers`: es el campo pesado del intento y aqui solo cuentan las cifras.
export const SIMULACRUM_ATTEMPT_FIELDS = {
    user_id: true, simulacrum_id: true, attempt_number: true, exam_finished: true, end_exam: true, start_exam: true,
    created_at: true, questions_correct: true, questions_incorrect: true, questions_not_answered: true,
    score: true, score_conversion: true, results: true,
};

const isNumber = { $type: 'number' };

/** Documentos de intentos de simulacro calificados del usuario (vivos y archivados). */
export const fetchGradedSimulacrumDocs = async (userId) => {
    const [live, archived] = await Promise.all([
        UserSimulacrumModel.find(
            { user_id: userId, finished: true, questions_correct: isNumber },
            { ...SIMULACRUM_ATTEMPT_FIELDS, finished: true },
        ).lean().exec(),
        SimulacrumAttemptModel.find(
            { user_id: userId, questions_correct: isNumber },
            { ...SIMULACRUM_ATTEMPT_FIELDS, user_simulacrum_id: true },
        ).lean().exec(),
    ]);
    return { live, archived };
};

// Acierto sobre lo respondido (null si no respondio nada). Fraccion 0-1 con 3
// decimales, la misma precision que el resto de los `accuracy`.
export const accuracyOf = (correct, incorrect) => {
    const answered = correct + incorrect;
    return answered > 0 ? Math.round((correct / answered) * 1000) / 1000 : null;
};

const toIso = (date) => (date ? new Date(date).toISOString() : null);

const serializePractice = (attempt, labels) => ({
    id: attempt._id,
    type: 'practica',
    source: attempt.source ?? 'lista',
    label: attempt.source === 'area'
        ? (labels.areas.get(attempt.area_id) ?? 'Práctica por área')
        : (labels.practices.get(attempt.practice_id) ?? 'Práctica'),
    area_id: attempt.area_id ?? null,
    topic: attempt.topic ?? null,
    practice_slug: attempt.practice_slug ?? null,
    at: toIso(attempt.created_at),
    total: attempt.total_questions ?? 0,
    correct: attempt.questions_correct ?? 0,
    incorrect: attempt.questions_incorrect ?? 0,
    not_answered: attempt.questions_not_answered ?? 0,
    accuracy: accuracyOf(attempt.questions_correct ?? 0, attempt.questions_incorrect ?? 0),
    time: attempt.time ?? 0,
});

const serializeSimulacrum = (attempt, simulacra) => {
    const simulacrum = simulacra.get(attempt.simulacrum_id);
    return {
        id: attempt.key,
        type: 'simulacro',
        source: 'simulacro',
        label: simulacrum?.title ?? 'Simulacro',
        simulacrum_slug: simulacrum?.slug ?? null,
        attempt_number: attempt.attempt_number,
        at: toIso(attempt.at),
        total: attempt.total,
        correct: attempt.correct,
        incorrect: attempt.incorrect,
        not_answered: attempt.not_answered,
        accuracy: accuracyOf(attempt.correct, attempt.incorrect),
        score: attempt.score,
        score_conversion: attempt.score_conversion,
        time: null,
    };
};

/**
 * Historial unificado, del mas reciente al mas antiguo. Las practicas se paginan
 * en la base (pueden ser muchas); los simulacros calificados son pocos y se
 * mezclan en memoria.
 */
export const listAttempts = async ({ userId, type = null, page, limit }) => {
    const wantsPractice = !type || type === 'practica';
    const wantsSimulacrum = !type || type === 'simulacro';

    // Para ordenar los dos origenes juntos hacen falta, de cada uno, los `page * limit` mas recientes.
    const window = page * limit;

    const [practiceDocs, practiceTotal, simulacrumDocs] = await Promise.all([
        wantsPractice
            ? PracticeAttemptModel.find({ user_id: userId }, { answers: 0 }).sort({ created_at: -1, _id: 1 }).limit(window).lean().exec()
            : [],
        wantsPractice ? PracticeAttemptModel.countDocuments({ user_id: userId }).exec() : 0,
        wantsSimulacrum ? fetchGradedSimulacrumDocs(userId) : { live: [], archived: [] },
    ]);

    const simulacrumAttempts = mergeGradedAttempts(simulacrumDocs.archived, simulacrumDocs.live);

    const areaIds = [...new Set(practiceDocs.map((doc) => doc.area_id).filter(Boolean))];
    const practiceIds = [...new Set(practiceDocs.map((doc) => doc.practice_id).filter(Boolean))];
    const simulacrumIds = [...new Set(simulacrumAttempts.map((attempt) => attempt.simulacrum_id).filter(Boolean))];

    const [areas, practices, simulacra] = await Promise.all([
        areaIds.length ? AreaModel.find({ _id: { $in: areaIds } }, { name: 1 }).lean().exec() : [],
        practiceIds.length ? UserQuestionsListModel.find({ _id: { $in: practiceIds } }, { name: 1 }).lean().exec() : [],
        simulacrumIds.length ? SimulacrumModel.find({ _id: { $in: simulacrumIds } }, { title: 1, slug: 1 }).lean().exec() : [],
    ]);

    const labels = {
        areas: new Map(areas.map((area) => [area._id, area.name])),
        practices: new Map(practices.map((practice) => [practice._id, practice.name])),
    };
    const simulacraById = new Map(simulacra.map((doc) => [String(doc._id), doc]));

    const items = [
        ...practiceDocs.map((doc) => serializePractice(doc, labels)),
        ...simulacrumAttempts.map((attempt) => serializeSimulacrum(attempt, simulacraById)),
    ].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || String(a.id).localeCompare(String(b.id)));

    return {
        items: items.slice(skipOf({ page, limit }), skipOf({ page, limit }) + limit),
        total: practiceTotal + (wantsSimulacrum ? simulacrumAttempts.length : 0),
    };
};
