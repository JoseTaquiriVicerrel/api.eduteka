import mongoose from 'mongoose';
import downloadSchema from '#Schemas/download_schema.js';

const Download = mongoose.models.Download || mongoose.model('Download', downloadSchema);

export default Download;
