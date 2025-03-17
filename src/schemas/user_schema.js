import mongoose from "mongoose";

const { Schema } = mongoose;

const userSchema = new Schema({
    _id: String,
    name: String,
    username: String,
    email: String,
    document_number: String,
    password: String,
    state: { type: Boolean, default: true },
    type: String,
    rol: String,
    created_by: String,
    token_verify: String,
    token_recovery_verify: String,
    points_rank: Number,
    count_question: Number,
    count_verified: Number,
    notification_send: { type: Boolean, default: false },
    count_pending: Number,
    mock_exam: Object,
    last_session: { type: Date },
    notification: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
});

const UserModel = mongoose.model('User', userSchema)

export default UserModel;