import mongoose from "mongoose";
import areaSchema from "#Schemas/area_schema.js";

const AreaModel = mongoose.models.Area || mongoose.model('Area', areaSchema);

export default AreaModel;
