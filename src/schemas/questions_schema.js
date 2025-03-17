import mongoose from "mongoose";

const { Schema } = mongoose;

const userSchema = new Schema({
    _id: String,
    topic: String,
    area: String,
    slug: String,
    competition: String,
    difficulty: String,
    type: String,
    image: String,
    question: String,
    question_raw: String,
    source: String,
    options: Map,
    options_answers: Map,
    dependence: { type: Object, ref: 'Block' },
    total_answers: Number,
    state: Boolean,
    resolution: String,
    verified: Boolean,
    rpta: String,
    rpta_text: String,
    created_by: String,
    verified_by: String,
    exam: String,
    exam_area: String,
    iexam: Object,
    hash: String,
    revision: String,
    n: Number,
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
});

const questionModel = mongoose.model('Question', userSchema)

export default questionModel;