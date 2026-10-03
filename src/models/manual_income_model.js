import mongoose from 'mongoose';
import manualIncomeSchema from '#Schemas/manual_income_schema.js';

const ManualIncome = mongoose.models.ManualIncome || mongoose.model('ManualIncome', manualIncomeSchema);

export default ManualIncome;
