import mongoose from 'mongoose';
import taskSchema from '#Schemas/task_schema.js';

const Task = mongoose.models.Task || mongoose.model('Task', taskSchema);

export default Task;
