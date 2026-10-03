import mongoose from 'mongoose';
import userQuestionsListSchema from '#Schemas/user_questions_list_schema.js';

const UserQuestionsList = mongoose.models.UserQuestionsList || mongoose.model('UserQuestionsList', userQuestionsListSchema);

export default UserQuestionsList;
