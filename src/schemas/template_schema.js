import mongoose from "mongoose";

const { Schema } = mongoose;

const templateSchema = new Schema({
    _id: String,
    name: String,
    file_name: String,
    file_path: String,
    file_image: String,
    created_by: String,
    public: Boolean,
    state: Boolean,
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
});

const templateModel = mongoose.model('Template', templateSchema)

export default templateModel;