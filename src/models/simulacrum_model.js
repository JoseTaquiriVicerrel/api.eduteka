import mongoose from 'mongoose';
import simulacrumSchema from '#Schemas/simulacrum_schema.js';

const Simulacrum = mongoose.models.Simulacrum || mongoose.model('Simulacrum', simulacrumSchema);

export default Simulacrum;
