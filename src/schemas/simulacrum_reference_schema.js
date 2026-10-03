import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Referencia inversa simulacro -> contenido, compartida por `questions` y por
 * `blocks`.
 *
 * La pertenencia a un simulacro solo existe DENTRO del documento del simulacro
 * (`general_items` y `areas[K].questions`). Este array es la copia inversa, para
 * poder preguntar "en que simulacros sale esto" sin recorrer la coleccion
 * entera. La fuente de verdad sigue siendo el simulacro: estas copias las
 * reconstruyen scripts/backfill_question_simulacrums.js y
 * scripts/backfill_block_simulacrums.js.
 *
 * Es un array, y no el campo `simulacrum` singular que ya existia, porque el
 * mismo contenido se reutiliza en varios simulacros.
 */
const simulacrumReferenceSchema = new Schema({
    id_simulacrum: String,
    simulacrum_slug: String,
    simulacrum_institution_id: String,
    simulacrum_title: String,
    simulacrum_areas: [String]
}, { _id: false });

export default simulacrumReferenceSchema;
