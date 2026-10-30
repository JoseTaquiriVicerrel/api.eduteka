import mongoose from 'mongoose';
import { AUDIENCE_KEYS, DEFAULT_PLACEMENT, PLACEMENT_KEYS } from '#Libs/banner_placements.js';

const { Schema } = mongoose;

// Pieza de un carrusel promocional. La coleccion `banners` la escribe el panel del monolito
// (src/schemas/banner_schema.js); la API solo la lee, asi que aqui no se declaran indices.
const bannerSchema = new Schema({
    _id: { type: String },
    title: { type: String, required: true, trim: true },
    image: { type: String, required: true },
    image_mobile: { type: String, default: '' },
    link_url: { type: String, default: '' },
    new_tab: { type: Boolean, default: false },
    placements: { type: [{ type: String, enum: PLACEMENT_KEYS }], default: [DEFAULT_PLACEMENT] },
    audiences: { type: [{ type: String, enum: AUDIENCE_KEYS }], default: [] },
    institution_ids: { type: [String], default: [] },
    start_at: { type: Date, default: null },
    end_at: { type: Date, default: null },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    clicks: { type: Number, default: 0 },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
});

export default bannerSchema;
