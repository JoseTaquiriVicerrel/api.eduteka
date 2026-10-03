import mongoose from 'mongoose';
import mockSchema from '#Schemas/mock_schema.js';

const Mock = mongoose.models.Mock || mongoose.model('Mock', mockSchema);

export default Mock;
