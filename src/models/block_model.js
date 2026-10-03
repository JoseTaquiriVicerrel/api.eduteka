import mongoose from 'mongoose';
import blockSchema from '#Schemas/block_schema.js';

const Block = mongoose.models.Block || mongoose.model('Block', blockSchema);

export default Block;
