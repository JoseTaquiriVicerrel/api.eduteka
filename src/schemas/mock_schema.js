import mongoose from 'mongoose';
import crypto from 'crypto';

const mockSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  user_id: String,
  exam_id: String,
  state: String,
  questions: Object,
  answers: Object,
  date_start: Date,
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default mockSchema;
