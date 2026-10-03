import AreaModel from '#Models/area_model.js';
import { ApiError } from '#Libs/api_error.js';

// Que preguntas del banco se sirven a los clientes.

// Banco oficial: todo lo que no sea del banco privado de un docente. Las
// preguntas anteriores al campo `origin` no lo tienen y tambien son oficiales,
// por eso se filtra por `$ne` y no por `origin: 'Oficial'` (mismo criterio que
// OFFICIAL_BANK_FILTER del monolito).
const OFFICIAL_BANK_FILTER = Object.freeze({ origin: { $ne: 'Docente' } });

/**
 * Filtro de una pregunta PRACTICABLE: oficial, verificada y con clave. Una
 * pregunta sin `rpta` no se puede corregir, asi que no se sirve (hay miles
 * verificadas sin clave).
 *
 * No exige `state: true`: el monolito no lo usa para servir preguntas y el campo
 * es `false` por defecto, asi que exigirlo podria ocultar casi todo el banco.
 */
export const practicableFilter = ({ areaId, topic, difficulty, institution, withResolution = false } = {}) => {
    const filter = { ...OFFICIAL_BANK_FILTER, verified: true, rpta: { $exists: true, $ne: null } };

    if (areaId) filter.area_id = areaId;
    if (topic) filter.topic = topic;
    if (difficulty) filter.difficulty = difficulty;
    if (institution) filter.iexam = { $elemMatch: { exam_institution_id: institution } };
    if (withResolution) filter.resolution = { $exists: true, $nin: [null, ''] };

    return filter;
};

/**
 * Un area se puede pedir por id o por slug (el cliente recibe ambos en /areas).
 * Devuelve el area o lanza 404.
 */
export const resolveArea = async (value) => {
    const area = await AreaModel.findOne({ $or: [{ _id: value }, { slug: value }] }, { _id: 1, name: 1, slug: 1 }).lean().exec();
    if (!area) throw ApiError.notFound('No encontramos esa área.');
    return area;
};
