import mongoose from 'mongoose';
import crypto from 'crypto';

const commentSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  comment: String,
  question_id: { type: String, ref: 'Question' },
  user_id: { type: String, ref: 'User' },
  user: Object,
  verified: { type: Boolean, default: true },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default commentSchema;
