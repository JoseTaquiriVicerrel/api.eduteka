import mongoose from 'mongoose';
import crypto from 'crypto';

const prospectSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    name: String,
    descripcion: String,
    institution: { type: String, ref: 'Institution' },
    calification_type: String, // Tipo de calificación
    academics_unit: Array, // Unidades academicas
    professional_areas: Object, // Areas profesionales del examen con sus respectivas profesiones
    subjects: Array, // Asignaturas/cursos del examen
    structure: Object,
    exam_type: String, // Examen UNICO (Para todas las areas profesionales) - Diferente Examen por Areas profesionales
    exam_unique: Boolean,
    calification: Object, // structura de la calificación
    questions_distribution: String,
    state: Boolean,
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default prospectSchema;
