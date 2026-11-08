import mongoose from 'mongoose';
import crypto from 'crypto';

const userQuestionsListSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    name: String,
    description: String,
    user: { type: String, ref: "User" },
    areas: Object,
    count_questions: Number,
    slug: String,
    public: { type: Boolean, default: false },
    verified:  { type: Boolean, default: false },
    favorites: { type: Number, default: 0 },
    questions: [{ type: String, ref: "Question" }],
    // Solo las practicas creadas desde /admin/practicas-sugeridas: `key` es la
    // familia (`A:sinonimos`), `via` 'A' | 'B' y `series` el numero N del nombre.
    // De aqui salen las preguntas ya usadas y el siguiente numero de la serie.
    suggestion: {
        key: String,
        via: String,
        series: Number,
    },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

userQuestionsListSchema.index({ 'suggestion.key': 1 }, { sparse: true });

// Sugerencias al terminar una practica (la API las calcula en practice.suggestions.js): la siguiente de la
// serie (key + series > N) y las mas guardadas entre las publicas. La API no crea indices: lo crea el monolito.
userQuestionsListSchema.index({ 'suggestion.key': 1, 'suggestion.series': 1 }, { sparse: true });
userQuestionsListSchema.index({ public: 1, favorites: -1, created_at: -1 });

export default userQuestionsListSchema;
