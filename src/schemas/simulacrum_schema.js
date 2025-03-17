import mongoose from "mongoose";

const { Schema } = mongoose;

const simulacrum_schema = new Schema({
  _id: String,
  exam_id: String,
  description: String,
  title: String,
  areas: Object,
  price: Number,
  slug: String,
  institution: { type: Object, ref: 'Institution' },
  verified: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
  date_program: Date,
  start_date: Date,
  end_date: Date,
  time: Number,
  image_post: String,
  score: Number,
  general: { type: Boolean, default: true },
  duration: Number,
  automatic: { type: Boolean, default: false },
  finished: { type: Boolean, default: false },
  questions: Object,
  prospect: { type: String, ref: 'Prospect' },
  state: { type: Boolean, default: true },
  score_correct: Number,
  score_incorrect: Number,
  score_notanswered: Number,
  for_register: { type: Boolean, default: true },
  public_results: Boolean,
});

const simulacrumModel = mongoose.model("Simulacrum", simulacrum_schema)

export default simulacrumModel;
