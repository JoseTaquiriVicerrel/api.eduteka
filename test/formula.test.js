import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/env.js';

// Las formulas de calificacion son TEXTO de la base que se evalua con mathjs (instancia recortada).
// Se comprueba el uso normal y que una formula maliciosa no pueda llamar a funciones peligrosas
// ni modificar prototipos (avisos de seguridad de mathjs < 15.2.0).

const { evaluateFormula, scoreByQuestions } = await import('#Libs/formula.js');

describe('formulas de calificacion (mathjs)', () => {
    it('evalua las formulas de conversion habituales con sus variables', () => {
        assert.equal(evaluateFormula('P * 2 + 10', { P: 30 }), 70);
        assert.equal(evaluateFormula('(P / 100) * 20', { P: 50 }), 10);
        assert.equal(evaluateFormula('round(P * 1.5)', { P: 3 }), 5);
        assert.equal(evaluateFormula('max(P, 11)', { P: 4 }), 11);
        assert.equal(evaluateFormula('P ^ 2', { P: 4 }), 16);
    });

    it('puntaje por correctas, incorrectas y omitidas, con conversion', () => {
        const calification = { score_correct: 2, score_incorrect: 0.5, score_not_answered: 0, score_conversion: true, score_formula_conversion: 'P * 2 + 10' };
        assert.deepEqual(scoreByQuestions(calification, { correct: 10, incorrect: 4, notAnswered: 6 }), { score: 18, score_conversion: 46 });
    });

    it('un resultado que no es un numero finito, o una formula rota, da null', () => {
        assert.equal(evaluateFormula('1 / 0'), null);
        assert.equal(evaluateFormula('P +', { P: 1 }), null);
        assert.equal(evaluateFormula('desconocida(1)'), null);
        assert.equal(evaluateFormula('"texto"'), null);
    });

    it('las funciones que evaluan mas texto o cambian el entorno estan deshabilitadas', () => {
        for (const expression of ['evaluate("1+1")', 'parse("1+1")', 'import({f: 1})', 'createUnit("x")', 'simplify("x+x")', 'derivative("x^2", "x")']) {
            assert.equal(evaluateFormula(expression), null, expression);
        }
    });

    it('una formula no puede contaminar prototipos ni alcanzar el entorno global', () => {
        const attacks = [
            'a = {}; a.__proto__.polluted = 1; 1',
            'a = {}; a["__proto__"]["polluted"] = 1; 1',
            'a = {}; a.constructor.prototype.polluted = 1; 1',
            'a = {}; a.constructor.constructor("return process")().exit(1)',
            'cos.constructor("return process")()',
        ];
        for (const expression of attacks) evaluateFormula(expression);

        assert.equal({}.polluted, undefined);
        assert.equal(Object.prototype.polluted, undefined);
    });

    it('el scope del llamador no se modifica', () => {
        const scope = { P: 3 };
        evaluateFormula('P = 99; P', scope);
        assert.equal(scope.P, 3);
    });
});
