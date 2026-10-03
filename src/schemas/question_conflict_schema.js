import mongoose from 'mongoose';
import crypto from 'crypto';

const { Schema } = mongoose;

const questionConflictSchema = new Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    question_a_id: { type: String, required: true, index: true },
    question_b_id: { type: String, required: true, index: true },
    exam_a_ids: [String], // IDs de los exámenes a los que pertenece la pregunta A
    exam_b_ids: [String], // IDs de los exámenes a los que pertenece la pregunta B
    conflict_type: { type: String, enum: ['internal', 'external'], required: true },
    match_type: { type: String, enum: ['exact', 'fuzzy'], required: true },
    similarity: { type: Number, required: true }, // Ej. 0.88
    status: { type: String, enum: ['pending', 'reviewed', 'resolved', 'ignored'], default: 'pending' },
    detected_at: { type: Date, default: Date.now }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

questionConflictSchema.index({ question_a_id: 1, question_b_id: 1 }, { unique: true });

export default questionConflictSchema;
