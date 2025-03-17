import mongoose from "mongoose";

const { Schema } = mongoose;

const reportSchema = new Schema({
  _id: String,
  name: Number,
  data: Object,
  state: Boolean,
  aditional: String,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const reportModel = mongoose.model("Report", reportSchema);

export default reportModel;