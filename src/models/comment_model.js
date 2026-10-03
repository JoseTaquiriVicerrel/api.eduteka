import mongoose from 'mongoose';
import commentSchema from '#Schemas/comment_schema.js';

const Comment = mongoose.models.Comment || mongoose.model('Comment', commentSchema);

export default Comment;
