import mongoose from "mongoose";
import questionConflictSchema from "#Schemas/question_conflict_schema.js";

const QuestionConflictModel = mongoose.models.QuestionConflict || mongoose.model('QuestionConflict', questionConflictSchema);

export default QuestionConflictModel;
