import { randomUUID } from 'node:crypto';
import ExamModel from '#Models/exam_model.js';
import FavoriteExamModel from '#Models/favorite_exam_model.js';
import QuestionModel from '#Models/question_model.js';
import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { canSeeSolutions, isPremium } from '#Libs/capabilities.js';
import { setNX } from '#Libs/kv.js';
import { skipOf } from '#Libs/paginate.js';
import {
    EXAM_SUMMARY_PROJECTION, serializeExamAreas, serializeExamFiles, serializeExamItems, serializeExamSummary,
} from '#Serializers/exam.serializer.js';
import { resolveArea } from '#Modules/questions/question.filters.js';

// Catalogo de examenes resueltos (no son intentos cronometrados: eso son los
// simulacros). Solo se sirven los examenes `verified: true`.

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cleanSearchText = (value) => String(value ?? '')
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

const findVerified = async (filter, projection) => {
    const exam = await ExamModel.findOne({ ...filter, verified: true }, projection).lean().exec();
    if (!exam) throw ApiError.notFound('No encontramos ese examen.');
    return exam;
};

// --- Catalogo ---------------------------------------------------------------

export const listExams = async ({ institution, modality, year, area, q, page, limit }) => {
    const filter = { verified: true };

    if (institution) filter['institution.id'] = institution;
    if (modality) filter.modality = modality;
    if (year) filter.date = { $gte: new Date(Date.UTC(year, 0, 1)), $lt: new Date(Date.UTC(year + 1, 0, 1)) };

    // Busqueda LITERAL en el titulo, sin distinguir mayusculas (no una expresion regular del usuario).
    const search = cleanSearchText(q);
    if (search) filter.title = new RegExp(escapeRegex(search), 'i');

    if (area) {
        // `subjects` guarda el texto de la materia, que tiene variantes por mayusculas.
        const { name, _id: areaId } = await resolveArea(area);
        const variants = await QuestionModel.distinct('area', { area_id: areaId });
        const names = [...new Set([name, ...variants.filter(Boolean)])];
        filter.subjects = { $in: names.map((text) => new RegExp(`^${escapeRegex(text)}$`, 'i')) };
    }

    const [items, total] = await Promise.all([
        ExamModel.find(filter, EXAM_SUMMARY_PROJECTION)
            .sort({ created_at: -1, _id: 1 })
            .skip(skipOf({ page, limit }))
            .limit(limit)
            .lean()
            .exec(),
        ExamModel.countDocuments(filter).exec(),
    ]);

    return { items: items.map(serializeExamSummary), total };
};

// --- Detalle ----------------------------------------------------------------

// Elementos del cuadernillo en su orden. `areas[K].items` es la composicion del
// cuadernillo y `general_items` el banco canonico del examen: un mismo id puede
// estar en varios cuadernillos. Los examenes antiguos no tienen banco y llevan las
// preguntas dentro del propio cuadernillo.
const resolveAreaItems = (exam, areaCode) => {
    const refs = exam.areas?.[areaCode]?.items ?? [];
    const bank = Array.isArray(exam.general_items) ? exam.general_items : [];

    let items;
    if (bank.length > 0) {
        const byId = new Map(bank.map((item) => [item.id ?? item._id, item]));
        // Un id que ya no esta en el banco se ignora en vez de romper el examen.
        items = refs.map((ref) => byId.get(ref.id)).filter(Boolean);
    } else {
        items = refs;
    }

    // Los marcadores `conflict` reservan el hueco de un duplicado aun sin resolver.
    return items.filter((item) => item?.itype !== 'conflict');
};

// Vista previa: sin suscripcion se sirven las primeras N preguntas (y las lecturas
// que las preceden). N = 0 desactiva el limite.
const applyPreview = (items, limit) => {
    if (limit <= 0) return items;

    const kept = [];
    let questions = 0;
    for (const item of items) {
        const isReading = item.itype === 'reading_section' || item.itype === 'block';
        if (!isReading) {
            if (questions >= limit) break;
            questions += 1;
        }
        kept.push(item);
    }
    // Una lectura final sin sus preguntas no aporta nada.
    while (kept.length && (kept.at(-1).itype === 'reading_section' || kept.at(-1).itype === 'block')) kept.pop();
    return kept;
};

export const getExam = async ({ slug, area, user }) => {
    const exam = await findVerified({ slug }, { ...EXAM_SUMMARY_PROJECTION, areas: 1, general_items: 1, unique: 1 });

    const codes = Object.keys(exam.areas && typeof exam.areas === 'object' ? exam.areas : {});
    if (codes.length === 0) throw ApiError.notFound('Este examen todavía no tiene contenido.');

    // Sin `area` se abre el primer cuadernillo (si el primero no tiene nombre, el segundo).
    const areaCode = area ?? (codes[0] === '' && codes[1] ? codes[1] : codes[0]);
    if (!codes.includes(areaCode)) throw ApiError.notFound('Ese cuadernillo no existe en el examen.');

    const all = resolveAreaItems(exam, areaCode);
    const totalQuestions = all.filter((item) => item.itype !== 'reading_section' && item.itype !== 'block').length;

    // Docentes y administradores ven las respuestas (material de trabajo) y no tienen vista previa.
    const canTeach = user ? canSeeSolutions(user) : false;
    const unrestricted = canTeach || (user ? isPremium(user) : false);
    const served = unrestricted ? all : applyPreview(all, settings.limits.examPreviewQuestions);
    const servedQuestions = served.filter((item) => item.itype !== 'reading_section' && item.itype !== 'block').length;

    const favorite = user
        ? Boolean(await FavoriteExamModel.exists({ exam_id: exam._id, user_id: user._id, state: true }))
        : false;

    return {
        ...serializeExamSummary(exam),
        unique: Boolean(exam.unique),
        favorite,
        areas: serializeExamAreas(exam),
        files: serializeExamFiles(exam),
        area: areaCode,
        access: {
            preview: servedQuestions < totalQuestions,
            total_questions: totalQuestions,
            served_questions: servedQuestions,
        },
        items: serializeExamItems(served, { includeAnswers: canTeach }),
    };
};

// --- Favoritos --------------------------------------------------------------

/**
 * Marca o desmarca un examen. Con `favorite` se FIJA el estado (reenviar la misma
 * peticion tras un corte de red no lo invierte); sin el, se alterna. El contador
 * del examen se recalcula contando, no sumando deltas, asi que no se desvia.
 */
export const setFavorite = async ({ user, examId, favorite }) => {
    await findVerified({ _id: examId }, { _id: 1 });

    // Doble toque: la segunda peticion identica espera.
    if (!(await setNX(`favorite-lock:${user._id}:${examId}`, 2))) {
        throw ApiError.conflict('Tu cambio anterior aún se está guardando.');
    }

    const current = await FavoriteExamModel.findOne({ user_id: user._id, exam_id: examId }, { state: 1 }).lean().exec();
    const desired = favorite ?? current?.state !== true;

    await FavoriteExamModel.updateOne(
        { user_id: user._id, exam_id: examId },
        { $set: { state: desired }, $setOnInsert: { _id: randomUUID() } },
        { upsert: true },
    ).exec();

    const total = await FavoriteExamModel.countDocuments({ exam_id: examId, state: true }).exec();
    // `favorites` es un campo "neutro" para el cache de examenes del monolito (ver exam_schema.js):
    // actualizarlo no invalida nada.
    await ExamModel.updateOne({ _id: examId }, { $set: { favorites: total } }, { timestamps: false }).exec();

    return { favorite: desired, favorites: total };
};

export const listFavorites = async ({ user, page, limit }) => {
    const filter = { user_id: user._id, state: true };

    const [rows, total] = await Promise.all([
        FavoriteExamModel.find(filter, { exam_id: 1, updated_at: 1 })
            .sort({ updated_at: -1, _id: 1 })
            .skip(skipOf({ page, limit }))
            .limit(limit)
            .lean()
            .exec(),
        FavoriteExamModel.countDocuments(filter).exec(),
    ]);

    const exams = rows.length
        ? await ExamModel.find({ _id: { $in: rows.map((row) => row.exam_id) }, verified: true }, EXAM_SUMMARY_PROJECTION).lean().exec()
        : [];
    const byId = new Map(exams.map((exam) => [exam._id, exam]));

    // Un favorito cuyo examen ya no esta publicado no se muestra (la pagina puede traer menos de `limit`).
    const items = rows
        .map((row) => (byId.has(row.exam_id)
            ? { ...serializeExamSummary(byId.get(row.exam_id)), favorited_at: row.updated_at ? new Date(row.updated_at).toISOString() : null }
            : null))
        .filter(Boolean);

    return { items, total };
};
