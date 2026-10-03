import mongoose from 'mongoose';
import orderSchema from '#Schemas/order_schema.js';

const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

export default Order;
