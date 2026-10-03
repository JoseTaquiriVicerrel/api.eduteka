import { scoreByAcademicArea, scoreByQuestions } from '#Libs/formula.js';

// Calificacion de un intento. Funcion pura: recibe el simulacro, el prospecto (si lo
// hay), la inscripcion y las preguntas YA completadas (ver simulacrum.questions.js),
// y devuelve los campos que se guardan en la inscripcion.
//
// Tres formas de puntuar, como en el monolito:
//   - prospecto `score_question`: B*correcta - M*incorrecta + N*omitida (+ conversion).
//   - prospecto `score_areas_units_academic`: la correcta pesa segun el area del examen y
//     el area profesional del postulante; el total es la suma de los puntajes por area.
//   - sin prospecto: correctas*score_correct + incorrectas*score_incorrect +
//     omitidas*score_not_answered (los tres puntajes viven en el simulacro).

const round = (value) => (Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null);

const emptyArea = () => ({
    questions_count: 0, questions_correct: 0, questions_incorrect: 0, questions_not_answered: 0, score: 0,
});

/** Una pregunta contestada es la que tiene su clave en el mapa de respuestas del intento. */
const answerOf = (answers, id) => (answers && Object.hasOwn(answers, id) ? answers[id] : undefined);

export const gradeAttempt = ({ simulacrum, prospect, enrollment, items }) => {
    const areas = {};
    const totals = { correct: 0, incorrect: 0, notAnswered: 0 };

    for (const item of items) {
        if (item.kind !== 'question') continue;

        const key = item.area ?? 'Sin área';
        const area = (areas[key] ??= emptyArea());
        area.questions_count += 1;

        const answer = answerOf(enrollment.answers, item.id);
        if (answer === undefined) {
            area.questions_not_answered += 1;
            totals.notAnswered += 1;
        } else if (answer?.option === item.rpta) {
            area.questions_correct += 1;
            totals.correct += 1;
        } else {
            area.questions_incorrect += 1;
            totals.incorrect += 1;
        }
    }

    const calification = prospect?.calification ?? null;
    const counts = (area) => ({ correct: area.questions_correct, incorrect: area.questions_incorrect, notAnswered: area.questions_not_answered });
    const plain = (area, scores) => (
        (area.questions_correct * (scores.score_correct ?? 0))
        + (area.questions_incorrect * (scores.score_incorrect ?? 0))
        + (area.questions_not_answered * (scores.score_not_answered ?? 0))
    );

    let score;
    let scoreConversion;

    if (calification && prospect.calification_type === 'score_question') {
        for (const area of Object.values(areas)) area.score = scoreByQuestions(calification, counts(area)).score ?? 0;
        ({ score, score_conversion: scoreConversion } = scoreByQuestions(calification, totals));
    } else if (calification && prospect.calification_type === 'score_areas_units_academic') {
        for (const [name, area] of Object.entries(areas)) {
            area.score = scoreByAcademicArea(calification, name, enrollment.area, counts(area)).score ?? 0;
        }
        score = Object.values(areas).reduce((sum, area) => sum + area.score, 0);
    } else {
        for (const area of Object.values(areas)) area.score = plain(area, simulacrum);
        score = plain({ questions_correct: totals.correct, questions_incorrect: totals.incorrect, questions_not_answered: totals.notAnswered }, simulacrum);
    }

    for (const area of Object.values(areas)) area.score = round(area.score);

    return {
        questions_correct: totals.correct,
        questions_incorrect: totals.incorrect,
        questions_not_answered: totals.notAnswered,
        score: round(score) ?? 0,
        ...(scoreConversion === undefined || scoreConversion === null ? {} : { score_conversion: round(scoreConversion) }),
        results: areas,
    };
};
