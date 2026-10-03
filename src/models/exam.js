import ExamModel from "#Models/exam_model.js";

const last_exams = async (limit = 7) => {
  const exams = await ExamModel.find({ verified: true }, {
    _id: true, title: true, description: true, slug: true, image_post: true
  }).sort({ created_at: -1 }).limit(limit).exec();

  return exams.map((exam) => ({ id: exam._id, ...exam._doc }));
};

const exams_related = async (examId, institutionId, limit = 3) => {
  let related = await ExamModel.find({
    _id: { $not: { $eq: examId } },
    "institution.id": institutionId,
    verified: true
  }).limit(limit).exec();

  if (related.length === 0) {
    related = await ExamModel.find(
      { _id: { $not: { $eq: examId } }, verified: true },
      { title: true, slug: true, image_post: true, description: true }
    ).limit(limit * 2).exec();
  }

  return related.map((doc) => ({ id: doc._id, ...doc._doc }));
};

const find_exam_by_slug = async (slug, fields = {}) => {
  return ExamModel.findOne({ slug }, fields).exec();
};

const find_exam_by_id = async (id, fields = {}) => {
  return ExamModel.findById(id, fields).exec();
};

const count_exams = async (filters = {}) => {
  return ExamModel.countDocuments(filters).exec();
};

export { last_exams, exams_related, find_exam_by_slug, find_exam_by_id, count_exams };
