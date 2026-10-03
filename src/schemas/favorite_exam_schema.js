import mongoose from 'mongoose';
import crypto from 'crypto';

const favoriteExamSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  exam_id: { type: String, require: true },
  user_id: { type: String, require: true },
  state: Boolean,
  user: Object,
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

favoriteExamSchema.index({ exam_id: 1, state: 1 });

export default favoriteExamSchema;
