import mongoose from 'mongoose';
import institutionSchema from '#Schemas/institution_schema.js';

const InstitutionModel = mongoose.models.Institution || mongoose.model('Institution', institutionSchema);

export default InstitutionModel;
