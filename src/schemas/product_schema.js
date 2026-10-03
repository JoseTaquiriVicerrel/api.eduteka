import crypto from 'crypto';
import { Schema } from 'mongoose';

const fileSchema = new Schema({
    name: { type: String },
    path: { type: String },
    area: { type: String }
}, { _id: false });


const productSchema = new Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    name: { type: String },
    description: { type: String },
    price: { type: Number },
    images: [String],
    state: { type: Boolean, default: false },
    type: { type: String },
    type_file: { type: String },
    poster: { type: String },
    source: { type: String },
    slug: { type: String },
    areas: { type: Object },
    unique: { type: Boolean, default: false },
    files: [fileSchema],
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default productSchema;
