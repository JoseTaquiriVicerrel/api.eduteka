import mongoose from "mongoose";
const { Schema }  = mongoose;

const productSchema = new Schema({
    _id: {
        type: String,
        default: crypto.randomUUID()
    },
    name: { type: String },
    description: { type: String },
    price: { type: Number },
    images: [String],
    state: { type: Boolean, default: false },
    type: { type: String },
    poster: { type: String },
    source: { type: String },
    slug: { type: String },
    created_at: {
        type: Date,
        default: Date.now
    },
    updated_at: {
        type: Date,
        default: Date.now
    }
});

const ProductModel =  mongoose.model('Product', productSchema);

export default ProductModel;