import mongoose from "mongoose";

const { Schema } = mongoose;

const userAnswerSchema = new Schema({
    _id: String,
    user_id: String,
    question_id: String,
    answer: String,
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
});

const UserAnswerModel = mongoose.model('userAnswer', userAnswerSchema)

export default UserAnswerModel;