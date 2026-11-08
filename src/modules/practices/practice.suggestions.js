import PracticeAttemptModel from '#Models/practice_attempt_model.js';
import QuestionModel from '#Models/question_model.js';
import UserQuestionsListModel from '#Models/user_questions_list_model.js';
import { logger } from '#Libs/logger.js';
import { practicableFilter } from '#Modules/questions/question.filters.js';

// Que practicar despues de terminar una practica. Dos grupos:
//
//   continue  seguir con lo mismo: el mismo tema, la siguiente de la serie, mas del area.
//   explore   algo distinto: un tema flojo o sin practicar del area, o practicas de otras areas.
//
// Cada sugerencia es de uno de dos tipos, segun como se empieza:
//   { type: 'list', ... }   una practica guardada: el cliente abre GET /practicas/:slug
//   { type: 'area', ... }   una tanda generada: el cliente llama GET /practicas-area/preguntas?area=&topic=
//
// Es un extra del cierre: si algo falla se devuelve vacio y el cierre de la practica no se ve afectado.

const LIMIT = 3;
const WEAK_ACCURACY = 0.6;
const WEAK_MIN_ANSWERS = 10; // mismo umbral que `weak_topics` del progreso

const EMPTY = () => ({ continue: [], explore: [] });

const PUBLIC_LISTS = Object.freeze({ slug: { $exists: true }, public: true });

const areaNames = (practice) => (Array.isArray(practice.areas) ? practice.areas : []).map((area) => area?.name).filter(Boolean);

const listSuggestion = (practice, reason) => ({
    type: 'list',
    reason,
    slug: practice.slug,
    name: practice.name ?? null,
    description: practice.description ?? null,
    count_questions: practice.count_questions ?? 0,
    favorites: practice.favorites ?? 0,
    areas: (Array.isArray(practice.areas) ? practice.areas : []).map((area) => ({ name: area?.name ?? null, count: area?.count ?? 0 })),
});

/** Listas publicas que el usuario ya resolvio (para no volver a sugerirlas). */
const resolvedListIds = async (userId) => {
    const ids = await PracticeAttemptModel.distinct('practice_id', { user_id: userId, source: 'lista' });
    return ids.filter(Boolean);
};

const findLists = (filter, sort, limit) => (limit > 0
    ? UserQuestionsListModel
        .find({ ...PUBLIC_LISTS, ...filter }, { name: 1, slug: 1, description: 1, areas: 1, count_questions: 1, favorites: 1 })
        .sort(sort)
        .limit(limit)
        .lean()
        .exec()
    : Promise.resolve([]));

const POPULAR = { favorites: -1, created_at: -1, _id: 1 };

const compute = {
    /** Al terminar una practica guardada (lista). */
    async list({ user, practice }) {
        const resolved = await resolvedListIds(user._id);
        const exclude = [...new Set([...resolved, practice._id])];
        const names = areaNames(practice);
        const key = practice.suggestion?.key ?? null;
        const series = Number.isFinite(practice.suggestion?.series) ? practice.suggestion.series : null;

        // Seguir: la siguiente de la serie (A: sinonimos 1 -> 2 -> 3) y, si falta, otras del mismo area.
        const next = key && series !== null
            ? await findLists({ 'suggestion.key': key, 'suggestion.series': { $gt: series }, _id: { $nin: exclude } }, { 'suggestion.series': 1 }, 2)
            : [];
        const sameArea = names.length
            ? await findLists({
                _id: { $nin: [...exclude, ...next.map((item) => item._id)] },
                areas: { $elemMatch: { name: { $in: names } } },
                ...(key ? { 'suggestion.key': { $ne: key } } : {}),
            }, POPULAR, LIMIT - next.length)
            : [];
        const keep = [...next.map((item) => listSuggestion(item, 'next_in_series')), ...sameArea.map((item) => listSuggestion(item, 'same_area'))];

        // Algo distinto: practicas de otras areas, las mas guardadas primero.
        const taken = [...exclude, ...next.map((item) => item._id), ...sameArea.map((item) => item._id)];
        const other = await findLists({ _id: { $nin: taken }, ...(names.length ? { 'areas.name': { $nin: names } } : {}) }, POPULAR, LIMIT);

        return { continue: keep.slice(0, LIMIT), explore: other.map((item) => listSuggestion(item, 'other_area')) };
    },

    /** Al terminar una tanda por area (y tema, si lo hubo). */
    async area({ user, area, topic }) {
        const areaId = area._id;
        const areaRef = { id: areaId, slug: area.slug ?? null, name: area.name ?? null };

        const [available, topics, stats, variants, resolved] = await Promise.all([
            QuestionModel.countDocuments(practicableFilter({ areaId, topic })).exec(),
            QuestionModel.aggregate([
                { $match: { ...practicableFilter({ areaId }), topic: { $exists: true, $nin: [null, ''] } } },
                { $group: { _id: '$topic', count: { $sum: 1 } } },
                { $sort: { count: -1, _id: 1 } },
            ]).exec(),
            PracticeAttemptModel.aggregate([
                { $match: { user_id: user._id, source: 'area', area_id: areaId, topic: { $nin: [null, ''] } } },
                {
                    $group: {
                        _id: '$topic',
                        correct: { $sum: '$questions_correct' },
                        total: { $sum: '$total_questions' },
                        last: { $max: '$created_at' },
                    },
                },
            ]).exec(),
            QuestionModel.distinct('area', { area_id: areaId }),
            resolvedListIds(user._id),
        ]);

        // Seguir: otra tanda del mismo tema (o del area, si no se eligio tema).
        const keep = available > 0
            ? [{ type: 'area', reason: topic ? 'same_topic' : 'same_area', area: areaRef, topic: topic ?? null, available_questions: available }]
            : [];

        // Algo distinto: temas del area, primero los flojos, luego los que nunca practico, luego los demas.
        const practiced = new Map(stats.map((row) => [row._id, row]));
        const accuracy = (row) => (row.total > 0 ? row.correct / row.total : null);
        const others = topics.filter((item) => item._id !== topic);

        const weak = others
            .filter((item) => {
                const row = practiced.get(item._id);
                return row && row.total >= WEAK_MIN_ANSWERS && accuracy(row) < WEAK_ACCURACY;
            })
            .sort((a, b) => accuracy(practiced.get(a._id)) - accuracy(practiced.get(b._id)));
        const fresh = others.filter((item) => !practiced.has(item._id));
        const rest = others
            .filter((item) => practiced.has(item._id) && !weak.includes(item))
            .sort((a, b) => new Date(practiced.get(a._id).last) - new Date(practiced.get(b._id).last));

        const topicSuggestion = (item, reason) => ({
            type: 'area',
            reason,
            area: areaRef,
            topic: item._id,
            available_questions: item.count,
            ...(reason === 'weak_topic' ? { accuracy: Math.round(accuracy(practiced.get(item._id)) * 100) / 100 } : {}),
        });
        const explore = [
            ...weak.map((item) => topicSuggestion(item, 'weak_topic')),
            ...fresh.map((item) => topicSuggestion(item, 'new_topic')),
            ...rest.map((item) => topicSuggestion(item, 'other_topic')),
        ].slice(0, LIMIT - 1);

        // Y al menos una practica guardada del area que no haya resuelto.
        const names = [...new Set([area.name, ...variants].filter(Boolean))];
        const lists = names.length
            ? await findLists({ _id: { $nin: resolved }, areas: { $elemMatch: { name: { $in: names } } } }, POPULAR, LIMIT - explore.length)
            : [];

        return { continue: keep, explore: [...explore, ...lists.map((item) => listSuggestion(item, 'same_area'))] };
    },
};

/** Sugerencias para despues de `source` ('list' | 'area'). Nunca lanza: ante un fallo devuelve vacio. */
export const suggestNext = async (source, params) => {
    try {
        return await compute[source](params);
    } catch (error) {
        logger.warn({ err: error?.message, source }, 'No se pudieron calcular las sugerencias de practica');
        return EMPTY();
    }
};
