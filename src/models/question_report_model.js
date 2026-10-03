import mongoose from 'mongoose';
import questionReportSchema from '#Schemas/question_report_schema.js';

const QuestionReport = mongoose.models.QuestionReport || mongoose.model('QuestionReport', questionReportSchema);

export default QuestionReport;
