import mongoose from 'mongoose';
import crypto from 'crypto';

const { Schema } = mongoose;

/**
 * PDF del que se extrajo el texto de un examen.
 *
 * Antes este archivo quedaba huerfano: `uploadExtractTextPdf` lo dejaba en
 * src/storage/upload y nadie lo borraba ni lo asociaba a nada (el import del
 * docente si lo borra, ver #Controllers/teacher_question.controllers.js). Eso
 * tenia dos consecuencias: la carpeta crecia sin limite, y cuando alguien
 * llegaba a revisar las preguntas ya no habia de donde sacar las figuras.
 *
 * Guardarlo enlazado es lo que permite, despues, rasterizar la pagina y recortar
 * la figura de cada pregunta marcada con [IMAGEN].
 *
 * Ojo: es OTRO archivo distinto del PDF publicado del cuadernillo, que vive en
 * `exam.files[area]` y lo sube #Services/exam-area.service.js.
 */
const examExtractionSchema = new Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    exam_slug: { type: String, default: null, index: true },
    // Cuadernillo destino cuando la carga es por area; vacio = examen completo.
    area: { type: String, default: null },
    original_name: { type: String, default: null },
    file_path: { type: String, required: true },
    pages: { type: Number, default: null },
    bytes: { type: Number, default: null },
    created_by: { type: String, default: null }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default examExtractionSchema;
