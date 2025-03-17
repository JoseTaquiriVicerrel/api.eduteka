import mongoose from "mongoose";

const { Schema } = mongoose;

const user_simulacrum_schema = new Schema({
  _id: String,
  user_id: { type: String, ref: "User", required: true },
  dni: String,
  fullname: String,
  area: String,
  simulacrum_id: String,
  career: String,
  answers: Object,
  start_exam: Date,
  end_exam: Date,
  exam_finished: Date, // Fecha de finalización del examen - Sistema - Usuario
  screenshot: String,
  time: Number,
  score: Number,
  public_results: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
  finished: { type: Boolean, default: false }, // Cierre del simulacro - Usuario - Sistema
  results: Object,
  questions_correct: Number,
  questions_incorrect: Number,
  questions_not_answered: Number,
  state: { type: Boolean, default: false }
});

const userSimulacrumModel = mongoose.model("UserSimulacrum", user_simulacrum_schema);

export default userSimulacrumModel;
