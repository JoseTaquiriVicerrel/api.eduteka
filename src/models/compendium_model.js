import mongoose from 'mongoose';
import compendiumSchema from '#Schemas/compendium_schema.js';

const CompendiumModel = mongoose.models.Compendium || mongoose.model('Compendium', compendiumSchema);

export default CompendiumModel;
