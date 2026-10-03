import mongoose from 'mongoose';
import activityLogSchema from '#Schemas/activity_log_schema.js';

const ActivityLog = mongoose.models.ActivityLog || mongoose.model('ActivityLog', activityLogSchema);

export default ActivityLog;
