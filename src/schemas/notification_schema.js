import mongoose from 'mongoose';
const { Schema } = mongoose;

const notificationSchema = new Schema({
    _id: { type: String},
    exam_id: { type: String, ref: 'Exam', required: true }, // Theme as primary reference
    subject: { type: String, required: true },
    sent_recipients: Array, // Array of recipients
    unsent_recipients: Array, // Array of recipients not sent
    sent: { type: Boolean, default: false },
    error: { type: String, default: null },
    sent_date: { type: Date, default: Date.now},
    total_sent: { type: Number, default: 0 }, // Total sent count
    total_errors: { type: Number, default: 0 } // Total error count
});

const notificationModel = mongoose.model('Notification', notificationSchema);

export default notificationModel;