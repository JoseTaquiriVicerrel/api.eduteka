import mongoose from "mongoose";
const { Schema } = mongoose;

const userQuestionsListSchema = new Schema({
    _id: String,
    name: String,
    description: String,
    user: { type: String, ref: "User" },
    slug: String,
    public: { type: Boolean, default: false },
    verified:  { type: Boolean, default: false },
    questions: [{ type: String, ref: "Question" }],
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
});

const userQuestionListModel = mongoose.model('userQuestionsList', userQuestionsListSchema);

export default userQuestionListModel;

