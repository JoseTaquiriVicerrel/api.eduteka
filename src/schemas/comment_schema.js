import mongoose from "mongoose";

const { Schema } = mongoose;

const commentSchema = new Schema({
  _id: String,
  comment: String,
  question_id: { type: String, ref: 'Question' },
  user_id: { type: String, ref: 'User' },
  user: Object,
  verified: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
});

const commentModel = mongoose.model('Comment', commentSchema)

export default commentModel;