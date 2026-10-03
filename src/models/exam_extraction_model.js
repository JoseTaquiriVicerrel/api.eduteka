import mongoose from 'mongoose';
import examExtractionSchema from '#Schemas/exam_extraction_schema.js';

const ExamExtraction = mongoose.models.ExamExtraction || mongoose.model('ExamExtraction', examExtractionSchema);

export default ExamExtraction;
