import mongoose from 'mongoose';
import practiceAttemptSchema from '#Schemas/practice_attempt_schema.js';

const PracticeAttempt = mongoose.models.PracticeAttempt || mongoose.model('PracticeAttempt', practiceAttemptSchema);

export default PracticeAttempt;
