import mongoose from 'mongoose';
import crypto from 'crypto';

const questionReportSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    question_id: {
        type: String,
        ref: 'Question',
        required: true
    },
    user_id: {
        type: String,
        ref: 'User',
        required: false
    },
    type: {
        type: String,
        enum: ['Pregunta', 'Opción', 'Respuesta'],
        required: true
    },
    description: {
        type: String,
        required: true,
        maxlength: 500
    },
    status: {
        type: String,
        enum: ['Pendiente', 'Revisado', 'Resuelto', 'Rechazado'],
        default: 'Pendiente'
    },
    reviewed_at: { type: Date },
    adminNote: {
        type: String
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default questionReportSchema;
