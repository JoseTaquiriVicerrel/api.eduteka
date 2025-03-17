import mongoose from "mongoose";

const { Schema } = mongoose;

const areaSchema = new Schema({
    _id: String,
    name: String,
    count: { type: Number, default: 0 },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
});

const areaModel = mongoose.model('Area', areaSchema)

export default areaModel;
