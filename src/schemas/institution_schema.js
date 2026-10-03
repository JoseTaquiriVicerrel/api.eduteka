import mongoose from 'mongoose';
import crypto from 'crypto';
const { Schema } = mongoose;

/*
const ProfesionalAreaSchema = new Schema({
  abrev: String,
  title: String,
  description: String,
  careers: [String]
}, { _id: false });
*/

const institutionSchema = new Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  name: String,
  description: String,
  abrev: String,
  image: String,
  state: Boolean,
  subjects: Array,
  modalities: Array,
  professional_areas: Object,
  departament: String,
  province: String,

  // Conteos denormalizados de examenes VERIFICADOS de la institucion, que hoy
  // se recalculan en cada request con dos aggregates: getInstitutionStats()
  // (#Services/exam.service.js) recorre todos los examenes verificados para el
  // combo de universidades, y getModalitiesInstitution() (#Models/question.js)
  // repite el group por modalidad en cada cambio del select.
  // Se mantienen desde createExam/updateExam, los unicos puntos que escriben
  // verified/modality/institution (no existe borrado de examenes en el codigo).
  exams_count: { type: Number, default: 0 },
  // [{ modality, count }] ordenado desc: misma forma que ya devuelve el
  // endpoint /institutions/get-modalities-exam-institution y que consume
  // getModalitiesExam() en /js/exams/index.js, para poder servirlo tal cual.
  exams_count_by_modality: { type: Array, default: [] },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false
});

export default institutionSchema;
