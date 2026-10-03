import { evaluate, create, all, parse } from "mathjs";

const evaluateMathExpression = (expression, scope = {}) => {
    try {
        // Parse the expression
        const expr = parse(expression);

        // Compile the expression for efficient evaluation
        const compiled = expr.compile();

        // Evaluate the expression with the given scope
        const result = compiled.evaluate(scope);
        console.log('result', result);
        return result;
    } catch (error) {
        console.error("Error evaluating expression:", error);
        return null; // Or throw the error, depending on your needs
    }
}

const calculateSoreByQuestions = (calification, results ) => {

    const mathExpresion = `B * ${calification.score_correct} - M * ${calification.score_incorrect} + N * ${calification.score_not_answered}`;
    const resultScore = {};

    resultScore.score = evaluateMathExpression( mathExpresion, {
        B: results.questionCorrect, // B = correct
        M: results.questionIncorrect, // M = incorrect
        N: results.questionNotAnswered // N = not answered
    });

    if ( calification.score_conversion ) {
        if ( resultScore.score <= 0 ) {
            resultScore.score_conversion = 0.00;
        } else {
            resultScore.score_conversion = evaluateMathExpression(calification.score_formula_conversion, { P: resultScore.score ?? 0 });
        }
    }

    console.log('resultScore', resultScore);

    return resultScore;
};
const calculateScoreByAreaAcademic = (calification, area, professional_area, results) => {

  console.log(calification,area, professional_area);
  const weightArea = calification["areas"][area]["professional_areas"][professional_area]; //Peso por area
  const mathExpresion = `B * ${weightArea} - M * ${calification.score_incorrect} + N * ${calification.score_not_answered}`;
  const resultScore = {};

  resultScore.score = evaluateMathExpression( mathExpresion, {
      B: results.questionCorrect, // B = correct
      M: results.questionIncorrect, // M = incorrect
      N: results.questionNotAnswered // N = not answered
  });

  if ( calification.score_conversion ) {
      if ( resultScore.score <= 0 ) {
          resultScore.score_conversion = 0.00;
      } else {
          resultScore.score_conversion = evaluateMathExpression(calification.score_formula_conversion, { P: resultScore.score ?? 0 });
      }
  }

  console.log('resultScore', resultScore);

  return resultScore;

}

export { evaluateMathExpression, calculateSoreByQuestions, calculateScoreByAreaAcademic };
