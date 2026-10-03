import mongoose from "mongoose";
import { randomUUID } from "crypto";
import redisClient from "#Config/redis.js";

const { Schema } = mongoose;

const ExamSchema = new Schema({
    _id: { type: String, default: randomUUID },
    title: { type: String },
    description: { type: String },
    unique: { type: Boolean },
    abrev: { type: String },
    slug: { type: String },
    type: { type: String },
    subjects: { type: Array },
    areas: { type: Object },
    institution: { type: Object },
    state: { type: String },
    source: { type: Object },
    modality: { type: String },
    favorites: { type: Number, default: 0 },
    date: { type: Date },
    general_items: { type: Array, default: [] },
    fases: { type: Object },
    files: { type: Object },
    notification: { type: Boolean, default: false },
    image_post: { type: String },
    verified: { type: Boolean, default: false },
    assigned_editor_id: { type: String, ref: 'User' },
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  versionKey: false
});

ExamSchema.index({ verified: 1, 'institution.id': 1, created_at: -1 });
ExamSchema.index({ slug: 1 });
ExamSchema.index({ verified: 1, modality: 1 });

// El detalle de examen se cachea 30 dias en Redis bajo `exams:<slug>` (ver
// getOrCacheExamDetail en #Services/exam.service.js). Ese payload incluye
// areas, general_items y las preguntas ya formateadas, y se edita desde ~28
// puntos distintos: admin de preguntas, bloques, areas y procesos de examen.
// Invalidar en cada call site resulto fragil - solo updateExam lo hacia, y el
// resto dejaba el cache obsoleto hasta 30 dias - asi que la invalidacion vive
// aqui, donde ninguna escritura puede saltarsela.

// favorites/updated_at se excluyen a proposito: marcar favorito es una accion
// frecuente de usuario y ese contador ya se recalcula fuera del cache en cada
// request, asi que invalidar por el solo tiraria un payload caro sin motivo.
const CACHE_NEUTRAL_PATHS = new Set(['favorites', 'updated_at']);

const onlyCacheNeutral = (paths) => paths.length > 0 && paths.every((path) => CACHE_NEUTRAL_PATHS.has(path));

const updatedPaths = (update = {}) => [
    ...Object.keys(update.$set ?? {}),
    ...Object.keys(update.$inc ?? {}),
    ...Object.keys(update).filter((key) => !key.startsWith('$')),
];

async function invalidateExamCache(slugs) {
    // Una caida de Redis no debe romper el guardado: el cache expira solo.
    try {
        for (const slug of slugs) {
            if (!slug) continue;
            const keys = await redisClient.keys(`exams:${slug}*`);
            if (keys.length > 0) {
                await redisClient.del(keys);
            }
        }
    } catch (error) {
        console.error('No se pudo invalidar el cache del examen:', error);
    }
}

ExamSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], async function () {
    if (onlyCacheNeutral(updatedPaths(this.getUpdate()))) {
        this._examSlugsToInvalidate = [];
        return;
    }

    // Se resuelve ANTES de escribir: updateExam puede cambiar el propio slug y
    // la clave que hay que borrar es la vieja.
    const filter = this.getFilter();
    if (typeof filter?.slug === 'string') {
        this._examSlugsToInvalidate = [filter.slug];
        return;
    }

    const docs = await this.model.find(filter, { slug: true }).lean();
    this._examSlugsToInvalidate = docs.map((doc) => doc.slug);
});

ExamSchema.post(['findOneAndUpdate', 'updateOne', 'updateMany'], async function () {
    await invalidateExamCache(this._examSlugsToInvalidate ?? []);
});

ExamSchema.pre('save', function () {
    // $locals es el scratch space que mongoose provee para pasar datos entre
    // hooks sin ensuciar el documento ni intentar persistir el flag.
    this.$locals.skipExamCacheInvalidation = onlyCacheNeutral(this.modifiedPaths());
});

ExamSchema.post('save', async function (doc) {
    if (doc.$locals.skipExamCacheInvalidation) return;
    await invalidateExamCache([doc.slug]);
});

export default ExamSchema;
