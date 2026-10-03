import mongoose from 'mongoose';
import paymentSchema from '#Schemas/payment_schema.js';

const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);

export default Payment;
