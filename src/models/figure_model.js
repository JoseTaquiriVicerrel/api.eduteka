import mongoose from 'mongoose';
import figureSchema from '#Schemas/figure_schema.js';

const Figure = mongoose.models.Figure || mongoose.model('Figure', figureSchema);

export default Figure;
