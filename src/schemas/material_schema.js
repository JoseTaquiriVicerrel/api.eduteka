import mongoose from 'mongoose';
import crypto from 'crypto';

const materialSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  title: String,
  step: Number,
  created_by: String,
  state: Boolean,
  aditional: String,
  questions: Array,
  // Banco del que salieron las preguntas ('oficial' | 'propio'). Se guarda para
  // poder volver al paso 2 con la misma rama activa: la validacion del POST
  // depende de ella, y sin esto una seleccion del banco propio se rechazaba al
  // regresar.
  bank: String,
  template: Map,
  // Valores de los campos propios de la plantilla ({curso}, {docente}, {fecha}...).
  // Van en el MATERIAL y no en la plantilla porque el mismo formato sirve para
  // varios materiales con distinto curso o fecha; la plantilla solo aporta la
  // LISTA de campos que hay que pedir (`custom_tags`, #Schemas/template_schema.js).
  fields: { type: Map, of: String },
  file_path: String,
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default materialSchema;
