import mongoose from "mongoose";
import userSchema from "#Schemas/user_schema.js";

const UserModel = mongoose.models.User || mongoose.model('User', userSchema);

export default UserModel;
