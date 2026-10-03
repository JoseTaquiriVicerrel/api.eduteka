import mongoose from 'mongoose';
import reportSchema from '#Schemas/report_schema.js';

const Report = mongoose.models.Report || mongoose.model('Report', reportSchema);

export default Report;
