import { absoluteUrl, absolutizeHtml } from '#Libs/urls.js';
import { optionEntries } from '#Serializers/question.serializer.js';

// Modelo -> JSON publico de los examenes, con lista blanca de campos.
//
// `files[area].path` (la ruta del PDF en disco) NUNCA sale de aqui: las descargas
// pasan por un endpoint que comprueba el permiso. Solo se expone que existe un PDF
// y de que area.

const iso = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const pdfAreas = (files) =>
    Object.entries(files && typeof files === 'object' ? files : {})
        .filter(([, file]) => file?.path)
        .map(([area, file]) => ({ area, title: file.title ?? area }));

/** Campos que se piden a Mongo para el listado. */
export const EXAM_SUMMARY_PROJECTION = Object.freeze({
    title: 1, description: 1, slug: 1, modality: 1, date: 1, institution: 1, image_post: 1,
    subjects: 1, favorites: 1, files: 1, created_at: 1,
});

export const serializeExamSummary = (exam) => ({
    id: exam._id,
    title: exam.title ?? null,
    description: exam.description ?? null,
    slug: exam.slug ?? null,
    modality: exam.modality ?? null,
    date: iso(exam.date),
    image: exam.image_post ? absoluteUrl(exam.image_post) : null,
    institution: exam.institution
        ? {
            id: exam.institution.id ?? null,
            name: exam.institution.name ?? null,
            abrev: exam.institution.abrev ?? null,
            image: exam.institution.image ? absoluteUrl(exam.institution.image) : null,
        }
        : null,
    subjects: Array.isArray(exam.subjects) ? exam.subjects : [],
    favorites: exam.favorites ?? 0,
    has_pdf: pdfAreas(exam.files).length > 0,
    created_at: iso(exam.created_at),
});

/** Cuadernillos del examen (A, B, I...). */
export const serializeExamAreas = (exam) =>
    Object.entries(exam.areas && typeof exam.areas === 'object' ? exam.areas : {}).map(([code, area]) => ({
        code,
        abrev: area?.abrev ?? code,
        title: area?.title ?? null,
        description: area?.description ?? null,
        // El solucionario de ese cuadernillo existe / esta verificado.
        solution: Boolean(area?.solution),
        verified: Boolean(area?.verified),
    }));

export const serializeExamFiles = (exam) => pdfAreas(exam.files);

/**
 * Elementos de un cuadernillo: lecturas (texto compartido) y preguntas numeradas.
 * Las preguntas salen SIN respuesta; con `includeAnswers` (cuentas de docente) se
 * añaden `correct` y `explanation`, igual que la web les muestra la respuesta
 * marcada.
 */
export const serializeExamItems = (items, { includeAnswers = false } = {}) => {
    let number = 0;

    return items.map((item) => {
        const id = item._id ?? item.id;

        if (item.itype === 'reading_section' || item.itype === 'block') {
            return { kind: 'reading', id, title: item.title ?? null, text: absolutizeHtml(item.text ?? item.texto ?? '') };
        }

        number += 1;
        const question = {
            kind: 'question',
            id,
            n: number,
            question: absolutizeHtml(item.question),
            options: optionEntries(item.options).map(([key, value]) => ({ key, text: absolutizeHtml(value) })),
            area: item.area ?? null,
            topic: item.topic ?? null,
            type: item.type ?? null,
        };

        if (includeAnswers) {
            question.correct = item.rpta ?? null;
            question.explanation = item.resolution ? absolutizeHtml(item.resolution) : null;
        }
        return question;
    });
};
