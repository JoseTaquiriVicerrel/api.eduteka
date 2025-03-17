import mongoose from "mongoose";

const { Schema } = mongoose;

const materialSchema = Schema({
  _id: String,
  step: Number,
  created_by: String,
  state: Boolean,
  aditional: String,
  questions: Array,
  template: Map,
  filte_path: String,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const materialModel = mongoose.model("Material", materialSchema);

export default materialModel;