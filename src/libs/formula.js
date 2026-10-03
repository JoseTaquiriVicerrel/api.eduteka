import { all, create } from 'mathjs';
import { logger } from '#Libs/logger.js';

// Evaluacion de las formulas de calificacion de los prospectos (por ejemplo
// `score_formula_conversion`, con la variable P). Las formulas las escribe un
// administrador, pero son TEXTO guardado en la base que se ejecuta: se evalua con
// una instancia de mathjs recortada, como recomienda su guia de seguridad, para que
// una formula no pueda llamar a funciones que cambian el entorno o evaluan mas texto.

const math = create(all);

// Se guarda ANTES de deshabilitar `evaluate`, que es lo que se usa aqui.
const evaluate = math.evaluate.bind(math);

const disabled = () => { throw new Error('Función deshabilitada'); };

math.import(
    {
        import: disabled,
        createUnit: disabled,
        evaluate: disabled,
        parse: disabled,
        simplify: disabled,
        derivative: disabled,
        resolve: disabled,
        reviver: disabled,
    },
    { override: true },
);

/** Evalua `expression` con `scope`. Devuelve un numero finito o null si falla. */
export const evaluateFormula = (expression, scope = {}) => {
    try {
        const result = evaluate(String(expression), { ...scope });
        const value = typeof result === 'number' ? result : Number(result);
        return Number.isFinite(value) ? value : null;
    } catch (error) {
        logger.error({ err: error.message, expression: String(expression).slice(0, 200) }, 'Formula de calificacion invalida');
        return null;
    }
};

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const conversionOf = (calification, score) => {
    if (!calification.score_conversion) return undefined;
    if (score === null || score <= 0) return 0;
    return evaluateFormula(calification.score_formula_conversion, { P: score });
};

/** Puntaje por correctas/incorrectas/omitidas: B*c - M*i + N*o (+ conversion). */
export const scoreByQuestions = (calification, { correct, incorrect, notAnswered }) => {
    const score = evaluateFormula(
        `B * ${num(calification.score_correct)} - M * ${num(calification.score_incorrect)} + N * ${num(calification.score_not_answered)}`,
        { B: correct, M: incorrect, N: notAnswered },
    );
    const conversion = conversionOf(calification, score);
    return conversion === undefined ? { score } : { score, score_conversion: conversion };
};

/** Igual, pero la correcta pesa segun el area del examen y el area profesional del postulante. */
export const scoreByAcademicArea = (calification, area, professionalArea, { correct, incorrect, notAnswered }) => {
    const weight = num(calification.areas?.[area]?.professional_areas?.[professionalArea]);
    const score = evaluateFormula(
        `B * ${weight} - M * ${num(calification.score_incorrect)} + N * ${num(calification.score_not_answered)}`,
        { B: correct, M: incorrect, N: notAnswered },
    );
    const conversion = conversionOf(calification, score);
    return conversion === undefined ? { score } : { score, score_conversion: conversion };
};
