import mongoose from 'mongoose';
import productSchema from '#Schemas/product_schema.js';

const ProductModel = mongoose.models.Product || mongoose.model('Product', productSchema);

export default ProductModel;
