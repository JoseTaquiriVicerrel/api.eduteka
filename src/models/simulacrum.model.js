import SimulacrumModel from "#Models/simulacrum_model.js";

const getSimulacrum = async (slug) => {

  return await SimulacrumModel.aggregate(
    [
      {
        $project: {
          _id: '$_id',
          title: '$title',
          slug: '$slug',
          price: '$price',
          start_date: '$start_date',
          end_date: '$end_date',
          score_correct: '$score_correct',
          score_incorrect: '$score_incorrect',
          score_not_answered: '$score_not_answered',
          description: '$description',
          automatic: '$automatic',
          general: '$general',
          duration: '$duration',
          general_items: '$general_items',
          image_post: '$image_post',
          areas: '$areas',
          state: '$state',
          prospect: '$prospect',
          verified: '$verified',
          finished: '$finished',
          public_results: '$public_results',
          for_register: '$for_register',
          calification_type: '$calification_type',
          date_program: {
            $dateToString: {
              format: "%d/%m/%Y %H:%M",
              date: "$date_program",
              timezone: "America/Lima"
            }
          }
        },
      },
      {
        $match: {
          slug: slug,
        }
      }
    ]
  ).limit(1).exec();
};

const getSimulacrums = async () => {
  const simulacrums = await SimulacrumModel.find({ verified: true, finished: false },{_id:true,slug:true, title:true, image_post:true }).exec();
  const map = simulacrums.map((doc) => ({ ...doc._doc }));
  return map;
}

const getSimulacrumRegister = async (slug, for_register = true) => {
  return await SimulacrumModel.aggregate(
    [
      {
        $project: {
          _id: '$_id',
          title: '$title',
          slug: '$slug',
          price: '$price',
          description: '$description',
          verified: '$verified',
          automatic: '$automatic',
          general: '$general',
          duration: '$duration',
          image_post: '$image_post',
          areas: '$areas',
          state: '$state',
          verified: '$verified',
          date_program: {
            $dateToString: {
              format: "%d/%m/%Y %H:%M",
              date: "$date_program",
              timezone: "America/Lima"
            }
          }
        },
      },
      {
        $match: {
          slug: slug,
          for_register: for_register
        }
      }
    ]).limit(1).exec();
}

export { getSimulacrum, getSimulacrumRegister,getSimulacrums };
