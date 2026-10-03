import mongoose from 'mongoose';
import crypto from 'crypto';

const reportSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  name: Number,
  data: Object,
  state: Boolean,
  aditional: String,
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default reportSchema;
