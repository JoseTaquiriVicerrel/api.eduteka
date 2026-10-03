import mongoose from 'mongoose';
import simulacrumAttemptSchema from '#Schemas/simulacrum_attempt_schema.js';

const SimulacrumAttempt = mongoose.models.SimulacrumAttempt || mongoose.model('SimulacrumAttempt', simulacrumAttemptSchema);

export default SimulacrumAttempt;
