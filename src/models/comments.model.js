import commentModel from "#Models/comment_model.js";
import commentExamModel from "#Models/exam_comment_model.js";

const get_comments_question = async (question_id) => {
  return await commentModel.aggregate(
    [
      {
        $match: {
          question_id: question_id
        }
      },
      {
        $project: {
          comment: "$comment",
          question_id: "$question_id",
          user_id: "$user_id",
          user: "$user",
          created_date_format: { $dateToString: { format: "%d/%m/%Y %H:%M", date: "$created_at", timezone: "America/Lima" } },
        }
      }
    ]
  ).exec();
}
const get_comments_question_user = async (question_id, user_id) => {
  return await commentModel.aggregate(
    [
      {
        $match: {
          question_id: question_id
        }
      },
      {
        $project: {
          comment: "$comment",
          question_id: "$question_id",
          user_id: "$user_id",
          user: "$user",
          created_by_user: { $cond: [{ $eq: ["$user_id", user_id] }, true, false] },
          created_date_format: { $dateToString: { format: "%d/%m/%Y %H:%M", date: "$created_at", timezone: "America/Lima" } },
        }
      }
    ]
  );
}
const get_comments_exam = async (id_exam) => {
  return await commentExamModel.aggregate(
    [
      {
        $match: {
          exam_id: id_exam
        }
      },
      {
        $project: {
          comment: "$comment",
          exam_id: "$question_id",
          user_id: "$user_id",
          user: "$user",
          created_date_format: {
            $dateToString: {
              format: "%d/%m/%Y %H:%M",
              date: "$created_at",
              timezone: "America/Lima"
            }
          },
        }
      }
    ]
  );
}

export { get_comments_question, get_comments_exam, get_comments_question_user };
