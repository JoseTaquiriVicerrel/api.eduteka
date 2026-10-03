import mongoose from 'mongoose';
import crypto from 'crypto';

const notificationSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    exam_id: { type: String, ref: 'Exam', required: true }, // Theme as primary reference
    subject: { type: String, required: true },
    sent_recipients: Array, // Array of recipients
    unsent_recipients: Array, // Array of recipients not sent
    sent: { type: Boolean, default: false },
    error: { type: String, default: null },
    sent_date: { type: Date },
    total_sent: { type: Number, default: 0 }, // Total sent count
    total_errors: { type: Number, default: 0 } // Total error count
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default notificationSchema;
