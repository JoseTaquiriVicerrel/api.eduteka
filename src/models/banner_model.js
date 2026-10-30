import mongoose from 'mongoose';
import bannerSchema from '#Schemas/banner_schema.js';

const BannerModel = mongoose.models.Banner || mongoose.model('Banner', bannerSchema);

export default BannerModel;
