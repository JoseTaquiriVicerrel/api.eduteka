import mongoose from 'mongoose';
import crypto from 'crypto';
import { generateBlockSlug } from '#Libs/slug_utils.js';
import simulacrumReferenceSchema from '#Schemas/simulacrum_reference_schema.js';

const blockSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    title: String,
    slug: String,
    type: String, // "reading_section", "divider_section"
    text: String,
    area: String,
    state: { type: Boolean, default: true }, //
    verified: { type: Boolean, default: false }, //
    questions: [{ type: String, ref: 'Question' }],
    // Mismos tres campos que en questions_schema.js y por el mismo motivo: un
    // texto de lectura importado por un docente es suyo y solo suyo. Sin
    // `origin` acabaria en /lecturas junto a los oficiales.
    // Ver OFFICIAL_BANK_FILTER en #Services/teacher_question.service.js
    origin: { type: String, enum: ['Oficial', 'Docente'], default: 'Oficial' },
    visibility: { type: String, enum: ['private', 'clase'] },
    created_by: { type: String },
    exam_id: { type: String },
    exam: { type: Object },
    // iexam: { type: Object },
    institution: { type: Object },
    // Snapshot del simulacro en el que se CREO la lectura. Es singular y de un
    // solo simulacro: no representa la reutilizacion, y sus copias de
    // title/slug se quedan obsoletas. Se conservan los dos porque
    // simulacrum.process.controllers.js todavia lee `simulacrum_id`
    // (ver el informe de scripts/backfill_block_simulacrums.js).
    simulacrum: { type: Object },
    simulacrum_id: { type: String },
    // Referencia inversa completa: TODOS los simulacros que contienen la
    // lectura, con las areas de cada uno. Espejo exacto de
    // `question.simulacrums`. La reconstruye
    // scripts/backfill_block_simulacrums.js desde los simulacros vivos, que son
    // la fuente de verdad.
    simulacrums: [simulacrumReferenceSchema],
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

// Listado de lecturas del docente en /mis-preguntas. Parcial como el equivalente
// de preguntas: solo cubre los bloques de docente, que son unos pocos.
blockSchema.index(
    { created_by: 1, created_at: -1 },
    { partialFilterExpression: { origin: 'Docente' } }
);

// Mismo indice que `questions.simulacrums.id_simulacrum`: cubre la consulta
// "que lecturas lleva este simulacro" sin recorrer la coleccion.
blockSchema.index({ 'simulacrums.id_simulacrum': 1 });

// `slug` es la clave publica de /lecturas/:slug. Es unico pero OPCIONAL, asi que
// el indice va parcial por el mismo motivo que el de preguntas: un indice unico
// simple no se construye en cuanto hay mas de un documento sin slug, y mongoose
// lo descarta en silencio.
blockSchema.index(
    { slug: 1 },
    { unique: true, partialFilterExpression: { slug: { $type: 'string' } } }
);

// El slug se asigna aqui y no en cada controlador por la misma razon que el
// `area_id` de las preguntas: los bloques se crean desde seis sitios (proceso de
// examen, panel de bloques, carga de simulacros, importacion de docentes...) y
// NINGUNO lo generaba. El resultado eran 126 lecturas sin slug cuyo boton "Ver
// preguntas" apuntaba a /lecturas/ en vez de a la lectura.
//
// La abreviatura sale del snapshot de institucion que ya traen los bloques; si
// no lo traen, el slug se queda sin ella (ver generateBlockSlug).
blockSchema.pre('save', function () {
    if (!this.slug) this.slug = generateBlockSlug(this.institution?.abrev);
});

blockSchema.pre('insertMany', function (next, docs) {
    if (!Array.isArray(docs)) return next();

    for (const doc of docs) {
        if (!doc?.slug) doc.slug = generateBlockSlug(doc?.institution?.abrev);
    }

    next();
});

export default blockSchema;
