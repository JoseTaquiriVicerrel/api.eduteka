import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFormula, scoreByAcademicArea, scoreByQuestions } from '#Libs/formula.js';
import { gradeAttempt } from '../src/modules/simulacra/simulacrum.grading.js';
import {
    attemptExpired, enrollmentState, isRetryInProgress, retryBlockedReason, simulacrumStatus, startWindowViolation,
} from '../src/modules/simulacra/simulacrum.state.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

describe('formulas de calificacion (mathjs recortado)', () => {
    it('evalua formulas aritmeticas con variables', () => {
        assert.equal(evaluateFormula('P * 2 + 10', { P: 3 }), 16);
        assert.equal(evaluateFormula('max(P, 5)', { P: 3 }), 5);
    });

    it('rechaza funciones que cambian el entorno o evaluan mas texto', () => {
        for (const expression of ['evaluate("1+1")', 'parse("1+1")', 'import({ x: 1 })', 'createUnit("foo")', 'simplify("x+x")']) {
            assert.equal(evaluateFormula(expression), null, expression);
        }
    });

    it('un resultado no finito o una formula rota dan null (no revientan el cierre del intento)', () => {
        assert.equal(evaluateFormula('1 / 0'), null);
        assert.equal(evaluateFormula('esto no es una formula ((('), null);
        assert.equal(evaluateFormula(undefined), null);
    });

    const calification = { score_correct: 2, score_incorrect: 0.5, score_not_answered: 0, score_conversion: true, score_formula_conversion: 'P * 2 + 10' };

    it('scoreByQuestions: B*c - M*i + N*o y conversion', () => {
        assert.deepEqual(scoreByQuestions(calification, { correct: 10, incorrect: 4, notAnswered: 6 }), { score: 18, score_conversion: 46 });
    });

    it('un puntaje no positivo se convierte a 0; sin conversion configurada no hay campo', () => {
        assert.equal(scoreByQuestions(calification, { correct: 0, incorrect: 4, notAnswered: 0 }).score_conversion, 0);
        assert.deepEqual(scoreByQuestions({ ...calification, score_conversion: false }, { correct: 1, incorrect: 0, notAnswered: 0 }), { score: 2 });
    });

    it('scoreByAcademicArea pesa la correcta segun el area del examen y el area profesional', () => {
        const academic = { score_incorrect: 1, score_not_answered: 0, areas: { Matemática: { professional_areas: { A: 3, B: 1 } } } };
        assert.equal(scoreByAcademicArea(academic, 'Matemática', 'A', { correct: 4, incorrect: 2, notAnswered: 1 }).score, 10);
        assert.equal(scoreByAcademicArea(academic, 'Matemática', 'B', { correct: 4, incorrect: 2, notAnswered: 1 }).score, 2);
        // Area sin peso configurado: pesa 0 en vez de romper la calificacion.
        assert.equal(scoreByAcademicArea(academic, 'Historia', 'A', { correct: 4, incorrect: 0, notAnswered: 0 }).score, 0);
    });
});

describe('estado del simulacro', () => {
    it('bajo demanda esta siempre abierto salvo que lo cierre el administrador', () => {
        assert.equal(simulacrumStatus({ automatic: false }, NOW), 'live');
        assert.equal(simulacrumStatus({ automatic: false, finished: true }, NOW), 'finished');
    });

    it('un evento es proximo, en vivo o terminado segun su ventana', () => {
        const event = (start, end, extra = {}) => ({ automatic: true, start_date: start, end_date: end, ...extra });
        assert.equal(simulacrumStatus(event(null, null), NOW), 'upcoming');
        assert.equal(simulacrumStatus(event(at(10), at(70)), NOW), 'upcoming');
        assert.equal(simulacrumStatus(event(at(-10), at(50)), NOW), 'live');
        assert.equal(simulacrumStatus(event(at(-10), null), NOW), 'live');
        assert.equal(simulacrumStatus(event(at(-90), at(-30)), NOW), 'finished');
        assert.equal(simulacrumStatus(event(at(-10), at(50), { finished: true }), NOW), 'finished');
    });

    it('startWindowViolation: solo los eventos tienen ventana', () => {
        assert.equal(startWindowViolation({ automatic: false }, NOW), null);
        assert.match(startWindowViolation({ automatic: true, start_date: at(5), end_date: at(60) }, NOW), /no ha comenzado/);
        assert.match(startWindowViolation({ automatic: true }, NOW), /no ha comenzado/);
        assert.match(startWindowViolation({ automatic: true, start_date: at(-60), end_date: at(-5) }, NOW), /cerró/);
        assert.equal(startWindowViolation({ automatic: true, start_date: at(-5), end_date: at(60) }, NOW), null);
    });
});

describe('intento y reintento', () => {
    it('attemptExpired: hay cronometro, no esta cerrado y paso el fin', () => {
        assert.equal(attemptExpired({ start_exam: at(-90), end_exam: at(-30) }, NOW), true);
        assert.equal(attemptExpired({ start_exam: at(-10), end_exam: at(50) }, NOW), false);
        assert.equal(attemptExpired({ start_exam: at(-90), end_exam: at(-30), finished: true }, NOW), false);
        // Sin start_exam (reintento recien abierto) no hay nada que vencer: comparar contra null daria "vencido".
        assert.equal(attemptExpired({ end_exam: null }, NOW), false);
        assert.equal(attemptExpired({}, NOW), false);
    });

    it('isRetryInProgress: intento > 1 sin cerrar', () => {
        assert.equal(isRetryInProgress({ attempt_number: 2, finished: false }), true);
        assert.equal(isRetryInProgress({ attempt_number: 2, finished: true }), false);
        assert.equal(isRetryInProgress({ attempt_number: 1, finished: false }), false);
        assert.equal(isRetryInProgress({ finished: false }), false);
        assert.equal(isRetryInProgress(null), false);
    });

    it('retryBlockedReason sigue el orden: inscripcion, verificacion, intento en curso, publicacion, area', () => {
        const sim = { verified: true, general: true };
        assert.match(retryBlockedReason(null, sim), /No estás inscrito/);
        assert.match(retryBlockedReason({ state: false, finished: true }, sim), /verificada/);
        assert.match(retryBlockedReason({ state: true, finished: false }, sim), /en curso/);
        assert.match(retryBlockedReason({ state: true, finished: true }, { verified: false }), /ya no está disponible/);
        assert.match(
            retryBlockedReason({ state: true, finished: true, area: 'A' }, { verified: true, general: false, areas: { A: { questions: [] } } }),
            /área/,
        );
        assert.equal(retryBlockedReason({ state: true, finished: true, area: 'A' }, { verified: true, general: false, areas: { A: { questions_count: 3 } } }), null);
        assert.equal(retryBlockedReason({ state: true, finished: true }, sim), null);
    });

    it('enrollmentState replica la ficha de la web', () => {
        const live = { automatic: false };
        assert.equal(enrollmentState(live, null, NOW), 'unregistered');
        assert.equal(enrollmentState(live, { state: true }, NOW), 'registered');
        assert.equal(enrollmentState(live, { state: true, start_exam: at(-5), end_exam: at(55) }, NOW), 'in_progress');
        assert.equal(enrollmentState(live, { state: true, start_exam: at(-90), end_exam: at(-30) }, NOW), 'finished');
        assert.equal(enrollmentState(live, { state: true, finished: true }, NOW), 'finished');
        // Un reintento manda sobre el estado global: un simulacro cerrado no lo esconde.
        assert.equal(enrollmentState({ automatic: false, finished: true }, { attempt_number: 2, finished: false, start_exam: at(-5), end_exam: at(55) }, NOW), 'in_progress');
    });
});

describe('gradeAttempt', () => {
    const q = (id, area, rpta) => ({ kind: 'question', id, area, rpta });
    const items = [{ kind: 'reading', id: 'r' }, q('1', 'Mat', 'A'), q('2', 'Mat', 'B'), q('3', 'Len', 'C'), q('4', 'Len', 'D')];
    const simulacrum = { score_correct: 4, score_incorrect: -1, score_not_answered: 0 };
    const answer = (option) => ({ option });

    it('cuenta correctas, incorrectas y omitidas por area, e ignora las lecturas', () => {
        const result = gradeAttempt({
            simulacrum, prospect: null, items,
            enrollment: { answers: { 1: answer('A'), 2: answer('A'), 3: answer('C') } },
        });

        assert.deepEqual([result.questions_correct, result.questions_incorrect, result.questions_not_answered], [2, 1, 1]);
        assert.equal(result.score, 7); // 2*4 + 1*(-1) + 0
        assert.deepEqual(result.results.Mat, { questions_count: 2, questions_correct: 1, questions_incorrect: 1, questions_not_answered: 0, score: 3 });
        assert.deepEqual(result.results.Len, { questions_count: 2, questions_correct: 1, questions_incorrect: 0, questions_not_answered: 1, score: 4 });
        assert.equal(result.score_conversion, undefined);
    });

    it('sin respuestas todo es omitido; las claves heredadas con valor nulo cuentan como respondidas incorrectas', () => {
        const empty = gradeAttempt({ simulacrum, prospect: null, items, enrollment: {} });
        assert.deepEqual([empty.questions_correct, empty.questions_incorrect, empty.questions_not_answered, empty.score], [0, 0, 4, 0]);

        const odd = gradeAttempt({ simulacrum, prospect: null, items, enrollment: { answers: { 1: null } } });
        assert.deepEqual([odd.questions_incorrect, odd.questions_not_answered], [1, 3]);
    });

    it('puntaje de prospecto con conversion', () => {
        const prospect = {
            calification_type: 'score_question',
            calification: { score_correct: 2, score_incorrect: 0.5, score_not_answered: 0, score_conversion: true, score_formula_conversion: 'P * 2 + 10' },
        };
        const result = gradeAttempt({ simulacrum: {}, prospect, items, enrollment: { answers: { 1: answer('A'), 2: answer('A') } } });
        assert.deepEqual([result.score, result.score_conversion], [1.5, 13]);
        assert.deepEqual(result.results.Mat.score, 1.5);
    });

    it('puntaje por areas academicas: la suma de los puntajes por area', () => {
        const prospect = {
            calification_type: 'score_areas_units_academic',
            calification: { score_incorrect: 1, score_not_answered: 0, areas: { Mat: { professional_areas: { X: 3 } }, Len: { professional_areas: { X: 2 } } } },
        };
        const result = gradeAttempt({
            simulacrum: {}, prospect, items, enrollment: { area: 'X', answers: { 1: answer('A'), 2: answer('B'), 3: answer('C'), 4: answer('A') } },
        });
        // Mat: 2 correctas * 3 = 6. Len: 1 correcta * 2 - 1 incorrecta * 1 = 1.
        assert.deepEqual([result.results.Mat.score, result.results.Len.score, result.score], [6, 1, 7]);
    });
});
