import mongoose from 'mongoose';
import questionsSchema from '#Schemas/questions_schema.js';

const Question = mongoose.models.Question || mongoose.model('Question', questionsSchema);

export default Question;
