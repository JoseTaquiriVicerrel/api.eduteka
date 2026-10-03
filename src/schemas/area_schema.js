import mongoose from "mongoose";
import { randomUUID } from "crypto";
import { formatAreaName } from "#Libs/area_utils.js";
import { convertSlug } from "#Libs/functions.js";

const { Schema } = mongoose;

const AreaSchema = new Schema({
    _id: { type: String, default: randomUUID },
    // Nombre de presentacion, capitalizado: "Lenguaje", "Historia del Perú".
    name: { type: String, trim: true },
    // Clave canonica del area (y de sus rutas /preguntas/area/:slug). Es lo que
    // permite reconocer que "ANATOMIA" y "ANATOMÍA" son la misma area.
    slug: { type: String, trim: true },
    count: { type: Number, default: 0 },
    institutions: [{ type: String }],
}, {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at"
    },
    versionKey: false
});

// El slug es unico, pero el indice se declara parcial por la misma razon que el
// de preguntas: un documento sin slug no debe tumbar la construccion del indice.
AreaSchema.index(
    { slug: 1 },
    { unique: true, partialFilterExpression: { slug: { $type: 'string' } } }
);

// La capitalizacion del nombre y el slug no se dejan al llamador: cada punto que
// creaba areas (areasExamsController, migrate_areas_topics.js, el admin) usaba
// su propio criterio y asi aparecieron 147 documentos para 84 areas reales
// ("ANATOMIA" / "ANATOMÍA", "CIENCIA Y TECNOLOGIA" / "...TECNOLOGÍA").
AreaSchema.pre('validate', function (next) {
    if (this.name) {
        this.name = formatAreaName(this.name);
        this.slug = convertSlug(this.name);
    }
    next();
});

export default AreaSchema;
