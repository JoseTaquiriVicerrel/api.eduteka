import mongoose from 'mongoose';
import prospectSchema from '#Schemas/prospect_schema.js';

const Prospect = mongoose.models.Prospect || mongoose.model('Prospect', prospectSchema);

export default Prospect;
