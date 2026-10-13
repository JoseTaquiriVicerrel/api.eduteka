import AreaModel from '#Models/area_model.js';
import BlockModel from '#Models/block_model.js';
import QuestionModel from '#Models/question_model.js';
import { ApiError } from '#Libs/api_error.js';
import { canSeeSolutions } from '#Libs/capabilities.js';
import { convertSlug } from '#Libs/functions.js';
import { skipOf } from '#Libs/paginate.js';
import { escapeRegex, stripQuestionMarkup } from '#Libs/text_utils.js';
import { absoluteUrl } from '#Libs/urls.js';
import { serializeExamItems } from '#Serializers/exam.serializer.js';

// Lecturas (/lecturas de la web): textos de comprension lectora (`blocks` de tipo
// reading_section) con sus preguntas. Mismo criterio que el monolito
// (block.controllers.js): solo las del banco oficial y verificadas.

// Un texto importado por un docente es suyo y no sale aqui (OFFICIAL_BANK_FILTER del monolito).
const BASE_FILTER = Object.freeze({ type: 'reading_section', verified: true, origin: { $ne: 'Docente' } });

// Las lecturas sin area son casi un tercio del banco (`area` null o ""): tienen su propia opcion.
export const NO_AREA_SLUG = 'sin-area';
const NO_AREA_NAME = 'Sin área';

const EXCERPT_LENGTH = 180;

const excerptOf = (html) => {
    const text = stripQuestionMarkup(html).replace(/\s+/g, ' ').trim();
    return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH).trimEnd()}…` : text;
};

const institutionOf = (block) => {
    const source = block.institution ?? block.exam?.institution ?? null;
    if (!source) return null;
    return {
        id: source.id ?? null,
        name: source.name ?? null,
        abrev: source.abrev ?? null,
        image: source.image ? absoluteUrl(source.image) : null,
    };
};

/**
 * Areas del filtro con su cantidad de lecturas. `block.area` es texto libre con
 * variantes de mayusculas ("RAZONAMIENTO VERBAL" / "Razonamiento Verbal"): se
 * juntan por slug (la clave del catalogo de areas) y se recuerdan las variantes,
 * que son con lo que luego se filtra (los bloques no tienen `area_id`).
 */
const groupAreas = async () => {
    const groups = await BlockModel.aggregate([
        { $match: BASE_FILTER },
        { $group: { _id: '$area', count: { $sum: 1 } } },
    ]).exec();

    const bySlug = new Map();
    for (const { _id: raw, count } of groups) {
        const slug = convertSlug(raw ?? '') || NO_AREA_SLUG;
        if (!bySlug.has(slug)) bySlug.set(slug, { slug, name: null, count: 0, variants: [] });
        const row = bySlug.get(slug);
        row.count += count;
        row.variants.push(raw ?? null);
        // Provisional: la variante mas larga suele traer las tildes. La definitiva es la del catalogo.
        if (slug !== NO_AREA_SLUG && String(raw ?? '').length > String(row.name ?? '').length) row.name = raw;
    }

    const noArea = bySlug.get(NO_AREA_SLUG);
    if (noArea) {
        noArea.name = NO_AREA_NAME;
        // "" y null son la misma fila; el filtro tiene que encontrar las dos.
        noArea.variants = [...new Set([...noArea.variants, null, ''])];
    }

    const catalog = await AreaModel.find({ slug: { $in: [...bySlug.keys()] } }, { name: 1, slug: 1 }).lean().exec();
    for (const area of catalog) {
        const row = bySlug.get(area.slug);
        if (row && area.name) row.name = area.name;
    }

    return [...bySlug.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
};

/** Areas del filtro: `[{slug, name, count}]`, las de mas lecturas primero ("Sin área" incluida). */
export const listReadingAreas = async () =>
    (await groupAreas()).map(({ slug, name, count }) => ({ slug, name, count }));

/** Listado paginado; `area` es el slug de una fila del filtro y `q` busca literal en el titulo y el texto. */
export const listReadings = async ({ area, q, page, limit }) => {
    const filter = { ...BASE_FILTER };

    if (area) {
        const row = (await groupAreas()).find((item) => item.slug === convertSlug(area));
        // Un area que no existe filtra por un conjunto vacio en vez de ignorarse.
        filter.area = { $in: row ? row.variants : [] };
    }

    const search = String(q ?? '').trim().slice(0, 120);
    if (search) {
        const pattern = new RegExp(escapeRegex(search), 'i');
        filter.$or = [{ title: pattern }, { text: pattern }];
    }

    const [items, total] = await Promise.all([
        BlockModel.find(filter, { title: 1, slug: 1, area: 1, text: 1, questions: 1, exam: 1, institution: 1 })
            .sort({ created_at: -1, _id: 1 })
            .skip(skipOf({ page, limit }))
            .limit(limit)
            .lean()
            .exec(),
        BlockModel.countDocuments(filter).exec(),
    ]);

    return {
        items: items.map((block) => ({
            id: block._id,
            slug: block.slug,
            title: block.title?.trim() || null,
            area: block.area?.trim() || null,
            excerpt: excerptOf(block.text),
            questions_count: block.questions?.length ?? 0,
            exam_title: block.exam?.title ?? null,
            institution: institutionOf(block),
        })),
        total,
    };
};

/**
 * Una lectura con sus preguntas, en la forma de los cuadernillos de examen: un
 * elemento `reading` y las preguntas numeradas, sin respuesta (se responde con
 * POST /preguntas/:id/responder, como en los examenes resueltos). El docente y el
 * administrador reciben `correct` y `explanation`, igual que en la web.
 */
export const getReading = async ({ slug, user }) => {
    const block = await BlockModel.findOne({ ...BASE_FILTER, slug }).lean().exec();
    if (!block) throw ApiError.notFound('No encontramos esa lectura.');

    const ids = (block.questions ?? []).map(String);
    const docs = ids.length
        ? await QuestionModel.find(
            { _id: { $in: ids }, verified: true, origin: { $ne: 'Docente' } },
            { question: 1, options: 1, area: 1, topic: 1, type: 1, rpta: 1, resolution: 1 },
        ).lean().exec()
        : [];
    const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
    // En el orden de la lectura; las que no estan verificadas (o ya no existen) no se sirven.
    const questions = ids.map((id) => byId.get(id)).filter(Boolean).map((doc) => ({ ...doc, itype: 'question' }));

    const reading = { _id: block._id, itype: 'reading_section', title: block.title, text: block.text };
    return {
        id: block._id,
        slug: block.slug,
        title: block.title?.trim() || null,
        area: block.area?.trim() || null,
        exam_title: block.exam?.title ?? null,
        institution: institutionOf(block),
        items: serializeExamItems([reading, ...questions], { includeAnswers: user ? canSeeSolutions(user) : false }),
    };
};
