import QuestionModel from "#Models/question_model.js";
import InstitutionModel from "#Models/institution_model.js";
import ExamModel from "#Models/exam_model.js";
import { OFFICIAL_BANK_FILTER } from "#Services/teacher_question.service.js";

const getModalitiesInstitution = async ( institution = null) => {

  // Camino normal (el unico que se usa: getModalitiesExamControler devuelve 404
  // si no llega institucion). Sirve el contador denormalizado que mantienen
  // createExam/updateExam, ya guardado con la forma [{modality, count}] y
  // ordenado desc, que es exactamente lo que espera el cliente.
  if (institution) {
    const doc = await InstitutionModel.findById(institution, { exams_count_by_modality: true }).lean().exec();
    return doc?.exams_count_by_modality ?? [];
  }

  // Sin institucion no hay contador que sirva (son por institucion), asi que
  // este caso sigue agregando en vivo sobre todos los examenes verificados.
  const filters = {
    verified:true
  };

  const modalities = await ExamModel.aggregate(
    [
      {
        $match: filters
      },
      {
        $group: {
          _id: "$modality",
          count: {
            $sum: 1,
          },
        },
      },
      {
        $sort: {
            count: -1
        }
      }
    ]
  ).exec();
  const modalityMap = modalities.map((item) => ({
    modality: item._id === "" ? "Sin modalidad" : item._id,
    count: item.count
  }))

  return modalityMap;
}

const get_areas_questions = async ( institution = null) => {

  const filters = {
    ...OFFICIAL_BANK_FILTER,
    verified:true
  };

  if (institution) {
    const questionInstitution = await InstitutionModel.findOne({ abrev: institution },{ _id:true, abrev:true }).lean().exec();
    // Una abreviatura que no existe (`/preguntas?institution=xxx`) tumbaba la
    // pagina con un TypeError al leer `._id`. Sin universidad no hay preguntas
    // suyas, asi que el listado de areas es vacio.
    if (!questionInstitution) return [];
    filters.iexam = {
      $elemMatch: {
        exam_institution_id: questionInstitution._id
      }
    }
  }

  const areas = await QuestionModel.aggregate(
    [
      {
        $match: filters
      },
      {
        $group: {
          _id: "$area",
          count: {
            $sum: 1,
          },
        },
      },
      {
        $sort: {
            count: -1
        }
      }
    ]
  ).exec();


  const areasMap = areas.map((item) => ({
    area: item._id === "" ? "Sin Area" : item._id,
    count: item.count
  }))

  return areasMap;
}

const getAreasQuestionsList = async ( filters  = {} ) => {

  const areas = await QuestionModel.aggregate(
    [
      {
        $match: filters
      },
      {
        $group: {
          _id: "$area",
          count: {
            $sum: 1,
          },
        },
      },
      {
          $sort: {
              count: -1
          }
      }
    ]
  ).exec();

  // console.log(areas);

  const areasMap = areas.map((item) => ({
    area: item._id === "" ? "Sin Area" : item._id,
    count: item.count
  }));

  return areasMap;
}

// `area` es un _id del catalogo de areas, no el texto del area.
/**
 * Areas del catalogo con preguntas, para los selectores que ya filtran por
 * `area_id`. A diferencia de `get_areas_questions`, que agrupa por el texto
 * libre y devuelve una fila por variante ("QUÍMICA" y "Química" por separado),
 * aqui cada area sale una sola vez y con su _id.
 */
const getAreasCatalogQuestions = async ( institution = null ) => {

  const filters = {
    ...OFFICIAL_BANK_FILTER,
    verified: true,
    area_id: { $exists: true, $ne: null }
  };

  if (institution) {
    filters.iexam = {
      $elemMatch: {
        exam_institution_id: institution
      }
    }
  }

  const areas = await QuestionModel.aggregate(
    [
      { $match: filters },
      {
        $group: {
          _id: "$area_id",
          count: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: "areas",
          localField: "_id",
          foreignField: "_id",
          as: "area"
        }
      },
      { $unwind: "$area" },
      {
        $project: {
          _id: true,
          name: "$area.name",
          slug: "$area.slug",
          count: true
        }
      },
      { $sort: { count: -1 } }
    ]
  ).exec();

  return areas;
}

// `area` es un _id del catalogo de areas, no el texto del area.
const get_topics_questions = async ( area = null, institution = null ) => {

  const filters = {
    ...OFFICIAL_BANK_FILTER,
    verified: true,
    topic: { $exists: true, $nin: [null, ""] }
  };

  if (area) filters.area_id = area;

  if (institution) {
    filters.iexam = {
      $elemMatch: {
        exam_institution_id: institution
      }
    }
  }

  const topics = await QuestionModel.aggregate(
    [
      {
        $match: filters
      },
      {
        $group: {
          _id: "$topic",
          count: {
            $sum: 1,
          },
        },
      },
      {
        $sort: {
            count: -1
        }
      }
    ]
  ).exec();

  const topicsMap = topics.map((item) => ({
    topic: item._id,
    count: item.count
  }))

  return topicsMap;
}

const get_areas_questions_admin = async () => {
  return await QuestionModel.aggregate(
    [
      {
        $group: {
          _id: "$area",
          count: {
            $sum: 1,
          },
        },
      }
    ]);
}

export { get_areas_questions, get_areas_questions_admin , getAreasQuestionsList, getAreasCatalogQuestions, getModalitiesInstitution, get_topics_questions};
