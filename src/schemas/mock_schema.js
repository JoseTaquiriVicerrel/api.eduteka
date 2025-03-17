import mongoose from "mongoose";

const { Schema } = mongoose;

const mockSchema = new Schema({
  _id: String,
  user_id: String,
  exam_id: String,
  state: String,
  questions: Object,
  answers: Object,
  date_start: {
    type: Date,
    default: Date.now
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

const mockModel = mongoose.model('Mock', mockSchema);

export default mockModel;