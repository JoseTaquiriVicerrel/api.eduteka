import mongoose from 'mongoose';
import admissionEventSchema from '#Schemas/admission_event_schema.js';

const AdmissionEvent = mongoose.models.AdmissionEvent || mongoose.model('AdmissionEvent', admissionEventSchema);

export default AdmissionEvent;
