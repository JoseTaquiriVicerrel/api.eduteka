import mongoose from 'mongoose';
import userAnswerSchema from '#Schemas/user_answer_schema.js';

const UserAnswer = mongoose.models.UserAnswer || mongoose.model('UserAnswer', userAnswerSchema);

export default UserAnswer;
