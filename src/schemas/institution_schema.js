import mongoose from "mongoose";

const { Schema } = mongoose;

const institutionSchema = new Schema({
    _id: String,
    name: String,
    description: String,
    abrev: String,
    image: String,
    state: Boolean,
    departament: String,
    province: String,
    created_at: { type: Date, default: Date.now },
});

const institutionModel = mongoose.model('Institution', institutionSchema)

export default institutionModel;
