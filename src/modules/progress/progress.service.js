import AreaModel from '#Models/area_model.js';
import PracticeAttemptModel from '#Models/practice_attempt_model.js';
import QuestionModel from '#Models/question_model.js';
import SimulacrumModel from '#Models/simulacrum_model.js';
import UserAnswerModel from '#Models/user_answer_model.js';
import { DAY_MS, dayKeyOf } from '#Libs/lima_time.js';
import { STUDENT_DAYS, buildStudentProgress } from '#Libs/progress_metrics.js';
import { listAreas } from '#Modules/catalog/catalog.service.js';
import { accuracyOf, fetchGradedSimulacrumDocs, listAttempts } from './attempts.service.js';
import { cacheProgress, getCachedProgress } from './progress.cache.js';

// Dashboard de progreso (GET /progreso). El calculo vive en #Libs/progress_metrics.js
// (el mismo del monolito: /mi-progreso); aqui se traen los datos de la base y se
// da forma al JSON. Nada se escribe: las cifras salen de lo que ya guardan las
// respuestas, las practicas y los simulacros.

// Un tema entra en "temas a reforzar" con al menos tantas respuestas corregibles.
export const WEAK_TOPIC_MIN_ANSWERED = 10;
const WEAK_TOPICS_LIMIT = 10;
const QUESTION_CHUNK = 5000;
const MAX_SESSION_SECONDS = 12 * 60 * 60;

// Catalogo de areas (~84) y conteos practicables: casi no cambian y los pide cada
// visita; se memorizan por proceso.
const MEMO_MS = 15 * 60 * 1000;
const memo = (load) => {
    let value = null;
    let loadedAt = 0;
    return async () => {
        if (value && Date.now() - loadedAt < MEMO_MS) return value;
        value = await load();
        loadedAt = Date.now();
        return value;
    };
};
const fetchCatalog = memo(() => AreaModel.find({}, { name: 1, slug: 1 }).lean().exec());
const fetchPracticableCounts = memo(async () => new Map((await listAreas()).map((area) => [String(area.id), area.count])));

/** Solo los campos que corrigen y clasifican una respuesta (las preguntas pesan mucho). */
const fetchQuestionMap = async (ids) => {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    const byId = new Map();
    for (let i = 0; i < unique.length; i += QUESTION_CHUNK) {
        const docs = await QuestionModel
            .find({ _id: { $in: unique.slice(i, i + QUESTION_CHUNK) } }, { rpta: 1, area_id: 1, area: 1, topic: 1 })
            .lean()
            .exec();
        for (const doc of docs) byId.set(String(doc._id), doc);
    }
    return byId;
};

// Porcentaje de la libreria (0-100, un decimal) -> fraccion 0-1 con 3 decimales: la
// precision de todos los `accuracy` del contrato (ver tambien accuracyOf).
const fraction = (percent) => (percent === null || percent === undefined ? null : Math.round(percent * 100) / 10_000);

const totalsView = (totals) => ({
    answered: totals.answered,
    practice: totals.practice,
    simulacro: totals.simulacro,
    accuracy: fraction(totals.accuracy),
});

// Segundos de estudio: tiempo de las practicas + duracion de los simulacros calificados.
const studySeconds = (practiceDocs, simulacrumDocs) => {
    const practice = practiceDocs.reduce((sum, doc) => sum + (Number.isFinite(doc.time) && doc.time > 0 ? doc.time : 0), 0);

    // Un intento puede estar en las dos colecciones (vivo y archivado): se cuenta una vez.
    const byAttempt = new Map();
    const duration = (doc) => {
        const start = doc.start_exam ? new Date(doc.start_exam) : null;
        const end = doc.exam_finished ? new Date(doc.exam_finished) : doc.end_exam ? new Date(doc.end_exam) : null;
        if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
        const seconds = Math.round((end - start) / 1000);
        return seconds > 0 && seconds <= MAX_SESSION_SECONDS ? seconds : 0;
    };
    for (const doc of simulacrumDocs.archived) byAttempt.set(`${doc.user_simulacrum_id}|${doc.attempt_number ?? 1}`, duration(doc));
    for (const doc of simulacrumDocs.live) byAttempt.set(`${doc._id}|${doc.attempt_number ?? 1}`, duration(doc));

    return practice + [...byAttempt.values()].reduce((sum, seconds) => sum + seconds, 0);
};

/** Ultimos 30 dias en hora de Lima (el eje que usa buildStudentProgress), de mas antiguo a hoy. */
const lastDayKeys = (now) => Array.from({ length: STUDENT_DAYS }, (_, i) => dayKeyOf(new Date(now.getTime() - (STUDENT_DAYS - 1 - i) * DAY_MS)));

const buildMetrics = async (userId, now) => {
    const [answerDocs, simulacrumDocs, practiceDocs, areas, practicable] = await Promise.all([
        UserAnswerModel.find({ user_id: userId }, { _id: false, question_id: true, answer: true, created_at: true, updated_at: true }).lean().exec(),
        fetchGradedSimulacrumDocs(userId),
        PracticeAttemptModel.find({ user_id: userId }, { _id: false, created_at: true, time: true }).lean().exec(),
        fetchCatalog(),
        fetchPracticableCounts(),
    ]);

    const questionById = await fetchQuestionMap(answerDocs.map((doc) => doc.question_id));

    const progress = buildStudentProgress({
        answerDocs,
        questionById,
        areas,
        live: simulacrumDocs.live,
        archived: simulacrumDocs.archived,
        practiceDates: practiceDocs.map((doc) => doc.created_at),
        practicable,
    }, now);

    const simulacrumIds = [...new Set(progress.simulacros.items.map((item) => item.simulacrum_id).filter(Boolean))];
    const simulacra = simulacrumIds.length
        ? await SimulacrumModel.find({ _id: { $in: simulacrumIds } }, { title: 1, slug: 1 }).lean().exec()
        : [];

    return { progress, practiceDocs, simulacrumDocs, simulacraById: new Map(simulacra.map((doc) => [String(doc._id), doc])) };
};

const shape = async (userId, now) => {
    const { progress, practiceDocs, simulacrumDocs, simulacraById } = await buildMetrics(userId, now);
    const { totals } = progress;
    const areaRows = progress.areas.areas;

    const keys = lastDayKeys(now);
    const accuracySeries = progress.series.day.accuracy;

    const weakTopics = areaRows
        .flatMap((area) => area.topics.map((topic) => ({ area, topic })))
        .filter(({ topic }) => topic.keyed >= WEAK_TOPIC_MIN_ANSWERED && topic.accuracy !== null)
        .sort((a, b) => a.topic.accuracy - b.topic.accuracy || b.topic.keyed - a.topic.keyed)
        .slice(0, WEAK_TOPICS_LIMIT)
        .map(({ area, topic }) => ({
            topic: topic.name,
            area: area.name,
            area_id: area.key,
            accuracy: fraction(topic.accuracy),
            answered: topic.keyed,
        }));

    const recent = await listAttempts({ userId, page: 1, limit: 10 });

    return {
        has_activity: progress.has_activity,
        summary: {
            attempts: totals.practices_finished + totals.simulacro_attempts,
            questions_answered: totals.answered,
            accuracy: fraction(totals.accuracy),
            study_time: studySeconds(practiceDocs, simulacrumDocs),
        },
        today: totalsView(progress.today),
        week: {
            current: totalsView(progress.week.cur),
            previous: totalsView(progress.week.prev),
            volume_delta_pct: progress.week.compare.volume_delta_pct,
            accuracy_delta_points: progress.week.compare.accuracy_delta_points,
            trend: progress.week.compare.trend,
        },
        streak: progress.streak,
        week_dots: progress.week_dots.map((dot) => ({ day: dot.name, letter: dot.letter, active: dot.active, is_today: dot.is_today, is_future: dot.is_future })),
        by_area: areaRows.map((area) => ({
            area_id: area.key,
            area: area.name,
            slug: area.slug,
            answered: area.total_answered,
            accuracy: fraction(area.accuracy),
            coverage: area.coverage ? { done: area.coverage.done, total: area.coverage.total, pct: area.coverage.pct } : null,
            is_weakest: area.is_weakest,
        })),
        weak_topics: weakTopics,
        trend: keys.map((date, index) => ({
            date,
            answered: progress.series.day.answered[index],
            accuracy: fraction(accuracySeries[index]),
        })),
        simulacra: progress.simulacros.items
            .filter((item) => item.at)
            .map((item) => {
                const info = simulacraById.get(item.simulacrum_id);
                return {
                    slug: info?.slug ?? null,
                    title: info?.title ?? 'Simulacro',
                    attempt_number: item.attempt_number,
                    score: item.score,
                    score_conversion: item.score_conversion,
                    accuracy: accuracyOf(item.correct, item.incorrect),
                    date: item.at.toISOString(),
                };
            }),
        recent_attempts: recent.items,
    };
};

/** Dashboard del usuario; cacheado 5 minutos (ver progress.cache.js). */
export const getProgress = async (userId, now = new Date()) => {
    const cached = await getCachedProgress(userId);
    if (cached) return cached;

    const result = await shape(userId, now);
    await cacheProgress(userId, result);
    return result;
};

