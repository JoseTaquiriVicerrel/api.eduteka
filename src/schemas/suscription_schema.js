import mongoose from 'mongoose';
import crypto from 'crypto';

const suscriptionSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    name: String, // "6 meses", "1 año"
    slug: String,
    duration_days: Number, // 180 (6 meses), 365 (1 año)
    duration_months: Number, // 6
    price: Number,
    description: String,
    state: Boolean,
    restricted_to_institution: { type: Boolean, default: false },
    // A quien se ofrece: 'Estudiante', 'Profesor' o 'Todos' (los planes anteriores al campo son 'Todos').
    audience: { type: String, enum: ['Estudiante', 'Profesor', 'Todos'], default: 'Todos' },
    // Lineas para la tarjeta del plan (<= 12 de <= 120 caracteres). Vacio = texto por defecto del cliente.
    benefits: { type: [String], default: [] },
    // Topes propios { list_questions, materials, templates }: enteros positivos y opcionales.
    // Se copian a user.suscription al activar el plan (#Libs/suscription_activation.js).
    limits: { type: Object },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

export default suscriptionSchema;
