import mongoose from 'mongoose';
import crypto from 'crypto';

const paymentSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    user_id: { type: String, ref: "User" }, // Referencia al usuario
    subscription_id: { type: String, ref: "Suscription" }, // Referencia al plan de suscripción
    institution_id: {type: String},
    amount: Number,
    payment_capture: String,
    message: String,
    payment_method: String, // "Paypal", "Yape"
    status: String, // "Completo", "Pendiente", "Cancelado"
    ai_analysis: Object,
    status_reason: String,
    transaction_type: String, // "Compra" "Renovación" "Actualización" "purchase", "renewal", "upgrade"
    payment_date: Date,
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

// El dashboard de ingresos filtra por rango de fechas y estado.
paymentSchema.index({ created_at: -1, status: 1 });

export default paymentSchema;
