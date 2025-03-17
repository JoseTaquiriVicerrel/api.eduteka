import mongoose from "mongoose";

const { Schema } = mongoose;

const commentExamSchema = new Schema({
  _id: String,
  comment: String,
  exam_id: { type: String, ref: 'Exam' },
  user_id: { type: String, ref: 'User' },
  user: Object,
  verified: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now }
});

const commentExamModel = mongoose.model('CommentExam', commentExamSchema)
export default commentExamModel;