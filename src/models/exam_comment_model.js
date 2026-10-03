import mongoose from 'mongoose';
import examCommentSchema from '#Schemas/exam_comment_schema.js';

const CommentExam = mongoose.models.CommentExam || mongoose.model('CommentExam', examCommentSchema);

export default CommentExam;
