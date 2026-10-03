import mongoose from 'mongoose';
import crypto from 'crypto';

const taskSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    target_id: { type: String, required: true }, // ID del Examen o Simulacro
    target_type: { type: String, required: true, enum: ['Exam', 'Simulacrum'] },
    content_editor_id: { type: String, ref: 'User' }, // Editor de contenido
    graphics_editor_id: { type: String, ref: 'User' }, // Editor de gráficos
    status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default taskSchema;
