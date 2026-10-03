import mongoose from 'mongoose';
import userSimulacrumSchema from '#Schemas/user_simulacrum_schema.js';

const UserSimulacrum = mongoose.models.UserSimulacrum || mongoose.model('UserSimulacrum', userSimulacrumSchema);

export default UserSimulacrum;
