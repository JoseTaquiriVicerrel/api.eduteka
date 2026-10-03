import mongoose from 'mongoose';
import templateSchema from '#Schemas/template_schema.js';

const Template = mongoose.models.Template || mongoose.model('Template', templateSchema);

export default Template;
