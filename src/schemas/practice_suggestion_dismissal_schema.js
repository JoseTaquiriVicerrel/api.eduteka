import mongoose from 'mongoose';

/**
 * Familias de practicas sugeridas que el administrador descarto.
 *
 * Las sugerencias NO se guardan: se calculan cada vez a partir del banco. Lo
 * unico que hay que recordar es lo que se dijo que no, y basta una fila por
 * familia. `_id` es la clave de la familia (`A:sinonimos`, `B:quimica:enlaces`).
 */
const practiceSuggestionDismissalSchema = new mongoose.Schema({
    _id: { type: String },
    user: { type: String, ref: 'User' },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default practiceSuggestionDismissalSchema;
