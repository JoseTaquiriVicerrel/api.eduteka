import MaterialModel from '#Models/material_model.js';
import QuestionModel from '#Models/question_model.js';
import TemplateModel from '#Models/template_model.js';
import UserQuestionsListModel from '#Models/user_questions_list_model.js';
import { limitsFor } from '#Libs/plan_limits.js';

// Resumen informativo del docente (tablero de Inicio de la app): cuanto ha creado en la web y los
// topes que le da su plan. Solo lee: crear y editar sigue siendo cosa de la web.

/** Un material solo cuenta (y se descarga) si ya se genero su archivo; los borradores no. */
export const GENERATED_MATERIAL = Object.freeze({ file_path: { $exists: true, $nin: [null, ''] } });

export const getTeacherSummary = async (user) => {
    const owner = user._id;
    const [questions, practices, materials, activeMaterials, templates] = await Promise.all([
        QuestionModel.countDocuments({ origin: 'Docente', created_by: owner }).exec(),
        UserQuestionsListModel.countDocuments({ user: owner }).exec(),
        MaterialModel.countDocuments({ created_by: owner, ...GENERATED_MATERIAL }).exec(),
        MaterialModel.countDocuments({ created_by: owner, state: true, ...GENERATED_MATERIAL }).exec(),
        TemplateModel.countDocuments({ created_by: owner }).exec(),
    ]);
    const limits = limitsFor(user);

    return {
        // Preguntas propias (banco del docente) y practicas / listas de preguntas.
        questions: { count: questions },
        practices: { count: practices, max_questions: limits.list_questions },
        // `count` incluye los desactivados; `active`, solo los activos.
        materials: { count: materials, active: activeMaterials, limit: limits.materials },
        templates: { count: templates, limit: limits.templates },
    };
};
