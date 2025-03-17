import mongoose from "mongoose";

const { Schema } = mongoose;

const favoriteExamSchema = new Schema({
  _id: String,
  exam_id: String,
  user_id: String,
  state: Boolean,
  user: Object,
  created_at: { type: Date, default: Date.now },
});

const favoriteExamModel = mongoose.model('favoriteExam', favoriteExamSchema)

export default favoriteExamModel;