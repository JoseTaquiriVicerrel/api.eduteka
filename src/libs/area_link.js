import AreaModel from '#Models/area_model.js';
import { convertSlug } from '#Libs/functions.js';

// El catalogo son ~84 documentos que casi no cambian, y una carga de examen
// resuelve la misma area cientos de veces seguidas: se cachea por proceso.
// Solo se cachean los aciertos, para que un area creada despues del arranque se
// resuelva en cuanto exista.
const cache = new Map();

/**
 * _id del area del catalogo que corresponde al area en texto de una pregunta.
 * El enlace es por slug: "QUÍMICA", "Química" y "QUIMICA" dan `quimica`.
 * Devuelve null si el area no esta en el catalogo.
 */
export const resolveAreaId = async (area) => {
    const slug = convertSlug(area ?? '');
    if (!slug) return null;

    if (cache.has(slug)) return cache.get(slug);

    const doc = await AreaModel.findOne({ slug }, { _id: true }).lean().exec();
    if (!doc) return null;

    cache.set(slug, doc._id);
    return doc._id;
};

/**
 * Valor listo para `filters.area_id` a partir del area en texto que mandan los
 * selectores y los enlaces publicos (/preguntas?area=QUÍMICA, que estan en el
 * menu y en Google: no se pueden cambiar por un _id).
 *
 * Si el area no esta en el catalogo devuelve un filtro que no matchea nada. No
 * se puede devolver `null` a secas: `{ area_id: null }` seleccionaria justo las
 * preguntas que no tienen area.
 */
export const areaIdFilter = async (area) => {
    const areaId = await resolveAreaId(area);
    return areaId ?? { $in: [] };
};

export const clearAreaCache = () => cache.clear();
