import mongoose from 'mongoose';
import favoriteExamSchema from '#Schemas/favorite_exam_schema.js';

const FavoriteExamModel = mongoose.models.FavoriteExam || mongoose.model('FavoriteExam', favoriteExamSchema);

export default FavoriteExamModel;
