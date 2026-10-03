import mongoose from 'mongoose';
import refreshTokenSchema from '#Schemas/refresh_token_schema.js';

const RefreshTokenModel = mongoose.models.RefreshToken || mongoose.model('RefreshToken', refreshTokenSchema);

export default RefreshTokenModel;
