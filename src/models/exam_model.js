import mongoose from "mongoose";
import examSchema from "#Schemas/exam_schema.js";

const ExamModel = mongoose.models.Exam || mongoose.model('Exam', examSchema);

export default ExamModel;
