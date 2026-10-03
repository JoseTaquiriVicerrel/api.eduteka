import mongoose from 'mongoose';
import crypto from 'crypto';

const { Schema } = mongoose;

/**
 * Figura parametrica (ver #Libs/figures). Guarda la especificacion que la
 * genero para poder reabrirla en el editor.
 *
 * Es inmutable: editar una figura crea otra con `parent_id` apuntando a la
 * anterior. Asi la URL de cada version no cambia nunca (sin problemas de cache
 * del estatico) y una pregunta que siga usando la version vieja no se altera.
 *
 * Los archivos viven en src/public/images/questions/ como fig_<id>.png/.svg,
 * junto al resto de imagenes de preguntas: el pre-save de `images`, el
 * exportador docx y los adjuntos de Gemini ya los reconocen sin cambios.
 */
const figureSchema = new Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    spec: { type: Schema.Types.Mixed, required: true },
    // md5 del JSON canonico: dos especificaciones iguales comparten figura.
    spec_hash: { type: String, required: true, index: true },
    png_url: { type: String, required: true },
    svg_url: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    source: { type: String, enum: ['editor', 'script', 'ai'], default: 'editor' },
    parent_id: { type: String, default: null, index: true },
    created_by: { type: String, default: null },
    // Biblioteca de graficos: con que se busca y se reutiliza una figura en otra
    // pregunta. La descripcion y las etiquetas salen de la misma llamada que
    // genero la especificacion, asi que no cuestan una peticion aparte.
    description: { type: String, default: null },
    area: { type: String, default: null },
    tags: { type: [String], default: [] },
    source_question_id: { type: String, default: null },
    usage_count: { type: Number, default: 0 },
    last_used_at: { type: Date, default: null }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    minimize: false
});

export default figureSchema;
