import mongoose from "mongoose";

const { Schema } = mongoose;

const examSchema = new Schema({
    _id: String,
    title: String,
    description: String,
    unique: Boolean,
    abrev: String,
    slug: String,
    type: String,
    subjects: Array,
    areas: Object,
    institution: Object,
    state: String,
    source: Object,
    modality: String,
    favorites: {
        type: Number,
        default: 0
    },
    date: Date,
    fases: Object,
    files: Object,
    notification: { type: Boolean, default: false },
    image_post: String,
    created_at: { type: Date, default: Date.now },
    verified: { type: Boolean, default: false },
});

const ExamModel = mongoose.model("Exam", examSchema);

export default ExamModel;