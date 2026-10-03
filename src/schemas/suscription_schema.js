import mongoose from 'mongoose';
import crypto from 'crypto';

const suscriptionSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    name: String, // "6 meses", "1 año"
    slug: String,
    duration_days: Number, // 180 (6 meses), 365 (1 año)
    duration_months: Number, // 6
    price: Number,
    description: String,
    state: Boolean,
    restricted_to_institution: { type: Boolean, default: false },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default suscriptionSchema;
