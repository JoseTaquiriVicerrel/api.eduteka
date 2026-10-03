import mongoose from 'mongoose';
import notificationSchema from '#Schemas/notification_schema.js';

const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);

export default Notification;
