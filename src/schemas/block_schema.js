import mongoose from 'mongoose';

const BlockSchema = new mongoose.Schema({
    _id: String,
    title: String,
    slug: String,
    type: String, // text - exam - question
    text: String,
    area: String,
    state: { type: Boolean, default: true },
    verified: { type: Boolean, default: false },
    questions: [{ type: String, ref: 'Question' }],
    exam_id: { type: String },
    exam: { type: Object },
    created_at: {
        type: Date,
        default: Date.now
    },
    institution: { type: Object },
    updated_at: {
        type: Date,
        default: Date.now
    }
});

const BlockModel = mongoose.model('Block', BlockSchema);

export default BlockModel;