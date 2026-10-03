import mongoose from 'mongoose';
import crypto from 'crypto';

const templateSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    name: String,
    file_template: String,
    poster_template: String,
    created_by: { type: String, ref:"User" },
    public: Boolean,
    state: Boolean,
    mappings: { type: Map, of: String },
    // Discriminante entre el catalogo de Eduteka y la plantilla propia de un
    // docente. "docente" es el unico valor que significa algo: TODO lo demas,
    // incluidas las plantillas anteriores a este campo (que no lo tienen), es
    // del catalogo. Por eso las lecturas filtran por `{ $ne: 'docente' }` y no
    // por `{ scope: 'oficial' }`, y por eso no hizo falta backfill.
    // Ver OFFICIAL_TEMPLATE_FILTER en #Services/teacher_template.service.js
    scope: { type: String, enum: ['oficial', 'docente'], default: 'oficial' },
    // Etiquetas del .docx que Eduteka no sabe rellenar, detectadas al subirlo
    // (#Services/docx/template-inspector.service.js). No son un error: son los
    // campos que el paso 1 del material le pide al docente que complete
    // ({curso}, {docente}, {fecha}...).
    custom_tags: [String],
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default templateSchema;
