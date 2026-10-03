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

export default userQuestionsListSchema;
