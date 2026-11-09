import mongoose from 'mongoose';
import admissionSourceSchema from '#Schemas/admission_source_schema.js';

const AdmissionSource = mongoose.models.AdmissionSource || mongoose.model('AdmissionSource', admissionSourceSchema);

export default AdmissionSource;
