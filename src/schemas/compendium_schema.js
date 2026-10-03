import crypto from 'crypto';
import { Schema } from 'mongoose';

const questionItemSchema = new Schema({
    question_id: { type: String, ref: 'Question' },
    area: String,
    area_id: String,
    topic: String,
}, { _id: false });

const examItemSchema = new Schema({
    exam_id: { type: String, ref: 'Exam' },
    area: String, // clave dentro de exam.areas elegida para este examen
    title: String,
    institution: Object,
    modality: String,
    date: Date,
    order: Number,
}, { _id: false });

const compendiumFileSchema = new Schema({
    name: String,
    path: String,
    dirpath: String,
}, { _id: false });

const compendiumSchema = new Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    type: { type: String, enum: ['preguntas', 'examenes'], required: true },
    title: { type: String, required: true },
    slug: { type: String },
    description: { type: String },
    price: { type: Number, default: 2.50 },
    poster: { type: String },
    state: { type: Boolean, default: false },
    is_product: { type: Boolean, default: false },
    product_id: { type: String, ref: 'Product' },
    file: compendiumFileSchema,
    count_questions: { type: Number },
    questions: [questionItemSchema],
    exams: [examItemSchema],
    created_by: { type: String, ref: 'User' },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default compendiumSchema;
