import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * Ingresos cobrados fuera de la plataforma, tipicamente ventas cerradas por
 * WhatsApp. No pasan por `Order` ni por `UserSimulacrum`, asi que sin esta
 * coleccion no existen en ningun lado y el dashboard subestima lo facturado.
 */
const manualIncomeSchema = new mongoose.Schema({
    _id: { type: String, default: () => crypto.randomUUID() },
    type: { type: String, enum: ['EXAMEN', 'SIMULACRO'], required: true },
    // Product._id cuando el tipo es EXAMEN, Simulacrum._id cuando es SIMULACRO.
    item_id: { type: String, required: true },
    // Copia del nombre al momento de registrar: si el producto se renombra o se
    // borra, el registro sigue diciendo que se vendio. Mismo criterio que
    // `Order.items[].name`.
    item_name: { type: String, required: true },
    amount: { type: Number, required: true },
    // Fecha en que se cobro, la elige el administrador. Es la que manda para
    // agrupar por mes: un cobro del mes pasado se registra hoy, y agrupar por
    // `created_at` lo pondria en el mes equivocado.
    income_date: { type: Date, required: true },
    note: { type: String },
    registered_by: { type: String, ref: 'User' },
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false
});

// El dashboard de ingresos filtra por rango de fechas de cobro.
manualIncomeSchema.index({ income_date: -1, type: 1 });

export default manualIncomeSchema;
