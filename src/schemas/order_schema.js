import mongoose from 'mongoose';
import crypto from 'crypto';

const orderSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    user_id: { type: String, required: true, ref: 'User' },
    items: [{
        product_id: { type: String, required: true, ref: 'Product' },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, default: 1 },
        areas: [] // Para exámenes seleccionados
    }],
    total: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    payment_method: { type: String, enum: ['transferencia', 'yape', 'plin', 'tarjeta'], default: 'yape' },
    payment_proof: { type: String }, // URL de la imagen subida
    status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    ai_analysis: { type: Object },
    status_reason: { type: String },
    // Nota del administrador al verificar o rechazar el pedido.
    message: { type: String },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

// El dashboard de ingresos filtra por rango de fechas y estado.
orderSchema.index({ created_at: -1, status: 1 });

export default orderSchema;
