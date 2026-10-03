import mongoose from 'mongoose';
import suscriptionSchema from '#Schemas/suscription_schema.js';

const Suscription = mongoose.models.Suscription || mongoose.model('Suscription', suscriptionSchema);

export default Suscription;
