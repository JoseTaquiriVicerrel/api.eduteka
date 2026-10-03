import mongoose from 'mongoose';
import materialSchema from '#Schemas/material_schema.js';

const Material = mongoose.models.Material || mongoose.model('Material', materialSchema);

export default Material;
