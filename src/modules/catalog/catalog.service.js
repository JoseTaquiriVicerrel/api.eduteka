import InstitutionModel from '#Models/institution_model.js';
import QuestionModel from '#Models/question_model.js';
import { absoluteUrl } from '#Libs/urls.js';
import { practicableFilter } from '#Modules/questions/question.filters.js';

// Instituciones con examenes. `state` solo se descarta si es explicitamente false:
// hay documentos antiguos sin el campo.
export const listInstitutions = async () => {
    const docs = await InstitutionModel
        .find({ state: { $ne: false } }, { name: 1, abrev: 1, image: 1, departament: 1, province: 1, exams_count: 1 })
        .sort({ name: 1, _id: 1 })
        .lean()
        .exec();

    return docs.map((doc) => ({
        id: doc._id,
        name: doc.name ?? null,
        abrev: doc.abrev ?? null,
        image: doc.image ? absoluteUrl(doc.image) : null,
        departament: doc.departament ?? null,
        province: doc.province ?? null,
        exams_count: doc.exams_count ?? 0,
    }));
};

// Areas con preguntas practicables, ordenadas por volumen. Cuenta solo las que de
// verdad se pueden responder: el catalogo general del monolito cuenta tambien las
// que no tienen clave, y el postulante veria mas preguntas de las que recibe.
export const listAreas = async ({ institution = null, withResolution = false } = {}) => {
    const areas = await QuestionModel.aggregate([
        { $match: practicableFilter({ institution, withResolution }) },
        { $group: { _id: '$area_id', count: { $sum: 1 } } },
        { $match: { _id: { $ne: null } } },
        { $lookup: { from: 'areas', localField: '_id', foreignField: '_id', as: 'area' } },
        { $unwind: '$area' },
        { $project: { _id: 1, name: '$area.name', slug: '$area.slug', count: 1 } },
        { $sort: { count: -1, name: 1 } },
    ]).exec();

    return areas.map((area) => ({
        id: area._id,
        name: area.name ?? null,
        slug: area.slug ?? null,
        count: area.count,
    }));
};
