import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MATH_ROUTE, MAX_TEX_LENGTH, buildMathImg, classifyFormula, decodeEntities, extractFormulas,
    mathHash, normalizeAccents, replaceMath, texForMode, texFromHtml,
} from '#Libs/math_svg.js';

const modeOf = (html, index = 0) => classifyFormula(html, extractFormulas(html)[index]);

describe('math_svg: extraccion', () => {
    it('reconoce \\[ \\], \\( \\) y $$ $$', () => {
        const html = 'a \\[x^2\\] b \\(y\\) c $$z$$ d';
        const found = extractFormulas(html);
        assert.deepEqual(found.map((f) => f.tex), ['x^2', 'y', 'z']);
        assert.deepEqual(found.map((f) => f.delimiter), ['\\[', '\\(', '$$']);
        assert.deepEqual(found.map((f) => f.display), [true, false, true]);
        for (const f of found) assert.equal(html.slice(f.start, f.end), f.raw);
    });

    it('varias formulas en un parrafo y dentro de <ul><li>', () => {
        const html = '<ul><li>\\(a\\)</li><li>\\(b\\) y \\(c\\)</li></ul>';
        assert.deepEqual(extractFormulas(html).map((f) => f.tex), ['a', 'b', 'c']);
    });

    it('sin formulas devuelve lista vacia y replaceMath devuelve el mismo string', async () => {
        assert.deepEqual(extractFormulas('<p>Hola</p>'), []);
        assert.deepEqual(extractFormulas(null), []);
        const html = '<p>Hola $5 y \\\\ nada</p>';
        const out = await replaceMath(html, () => assert.fail('no debe convertir'));
        assert.equal(out.html, html);
        assert.equal(out.found, 0);
    });

    it('ignora script, style, code, pre y atributos', () => {
        const html = [
            '<script>var a = "\\(x\\)";</script>',
            '<style>.a::after{content:"\\[y\\]"}</style>',
            '<code>\\(z\\)</code><pre>$$w$$</pre>',
            '<img alt="\\(v\\)" src="/a.png">',
            '\\(real\\)',
        ].join('');
        assert.deepEqual(extractFormulas(html).map((f) => f.tex), ['real']);
    });

    it('un delimitador sin cierre no rompe lo que sigue', () => {
        assert.deepEqual(extractFormulas('sin cerrar \\[x y \\(ok\\)').map((f) => f.tex), ['ok']);
    });

    it('descarta las vacias y las de mas de MAX_TEX_LENGTH', () => {
        assert.deepEqual(extractFormulas('\\[  \\] \\(<br>\\)'), []);
        assert.deepEqual(extractFormulas(`\\(${'x'.repeat(MAX_TEX_LENGTH + 1)}\\)`), []);
        assert.equal(extractFormulas(`\\(${'x'.repeat(MAX_TEX_LENGTH)}\\)`).length, 1);
    });
});

describe('math_svg: TeX a partir del HTML', () => {
    it('decodifica entidades (&lt; &amp; &nbsp; numericas)', () => {
        assert.equal(decodeEntities('a &lt; b &amp;&amp; c &gt; d&nbsp;e &#8804; &#x2265; &foo;'), 'a < b && c > d e ≤ ≥ &foo;');
        assert.equal(texFromHtml('x &lt; 3'), 'x < 3');
    });

    it('quita etiquetas dentro de la formula y convierte <br> en espacio', () => {
        assert.equal(texFromHtml('a<br>b'), 'a b');
        assert.equal(texFromHtml('<span>x</span>+<b>y</b>'), 'x+y');
        // Una etiqueta escrita como texto (&lt;b&gt;) es TeX, no HTML.
        assert.equal(texFromHtml('a &lt;b&gt; c'), 'a <b> c');
        assert.equal(extractFormulas('\\[ a<br>b \\]')[0].tex, 'a b');
    });

    it('normaliza las tildes solo dentro de \\text{}', () => {
        assert.equal(normalizeAccents('\\text{términos}'), "\\text{t\\'erminos}");
        assert.equal(normalizeAccents('\\text{año ü}'), '\\text{a\\~no \\"u}');
        assert.equal(normalizeAccents('\\text{aí}'), "\\text{a\\'{\\i}}");
        assert.equal(normalizeAccents('\\text{a}+é'), '\\text{a}+é', 'fuera de \\text no se toca');
        assert.equal(normalizeAccents('\\text{a {é} b} é'), "\\text{a {\\'e} b} é", 'llaves anidadas');
        assert.equal(normalizeAccents('x+y'), 'x+y');
        assert.equal(normalizeAccents('\\text{é'), '\\text{é', 'llave sin cerrar: se deja igual');
    });
});

describe('math_svg: bloque o en linea (casos reales del banco)', () => {
    it('\\[ \\] sola en su parrafo es bloque', () => {
        assert.equal(modeOf('<p>\\[x^2+1\\]</p>'), 'block');
        assert.equal(modeOf('<p>\\[x^2+1\\]</p>\n'), 'block');
        assert.equal(modeOf('\\[x^2\\]'), 'block');
    });

    it('tras un <br> y sola en su linea es bloque', () => {
        assert.equal(modeOf('Calcula:<br>\\[x^2\\]<br>y luego'), 'block');
        assert.equal(modeOf('<p>Texto</p><p>$$x$$</p>'), 'block');
    });

    it('comparte linea con texto: en linea con \\displaystyle', () => {
        assert.equal(modeOf('20 \\[\\Omega\\] cada una'), 'inline-display');
        assert.equal(modeOf('<p>Si: <img src="/a.png"> \\[=4x-1\\] y mas</p>'), 'inline-display');
    });

    it('comparte linea solo con una <img> o con otra formula', () => {
        assert.equal(modeOf('<p>\\[x\\]<img src="/a.png"></p>'), 'inline-display');
        assert.equal(modeOf('<p>\\[a\\] \\[b\\]</p>', 0), 'inline-display');
        assert.equal(modeOf('<p>\\[a\\] \\[b\\]</p>', 1), 'inline-display');
    });

    it('espacios y &nbsp; no cuentan como texto', () => {
        assert.equal(modeOf('<p>&nbsp; \\[x\\] &nbsp;</p>'), 'block');
    });

    it('\\( \\) siempre va en linea', () => {
        assert.equal(modeOf('<p>\\(x\\)</p>'), 'inline');
        assert.equal(modeOf('a \\(x\\) b'), 'inline');
    });

    it('texForMode antepone \\displaystyle solo en inline-display', () => {
        assert.equal(texForMode('x', 'inline-display'), '\\displaystyle x');
        assert.equal(texForMode('x', 'inline'), 'x');
        assert.equal(texForMode('x', 'block'), 'x');
    });
});

describe('math_svg: hash e <img>', () => {
    it('mismo TeX+modo+version -> mismo hash de 32 hex; cualquier cambio lo cambia', () => {
        const base = mathHash({ tex: 'x^2', mode: 'block', version: '3.2.1' });
        assert.match(base, /^[a-f0-9]{32}$/);
        assert.equal(mathHash({ tex: 'x^2', mode: 'block', version: '3.2.1' }), base);
        assert.notEqual(mathHash({ tex: 'x^3', mode: 'block', version: '3.2.1' }), base);
        assert.notEqual(mathHash({ tex: 'x^2', mode: 'inline', version: '3.2.1' }), base);
        assert.notEqual(mathHash({ tex: 'x^2', mode: 'block', version: '4.0.0' }), base);
    });

    it('buildMathImg escapa el TeX y expone medidas y modo', () => {
        const img = buildMathImg({ hash: 'a'.repeat(32), tex: 'a<b & "c"', mode: 'block', w: '5.12ex', h: '2ex', valign: '-0.5ex' }, { baseUrl: 'https://api.test' });
        assert.equal(img, `<img class="math" src="https://api.test${MATH_ROUTE}${'a'.repeat(32)}.svg" alt="a&lt;b &amp; &quot;c&quot;" data-tex="a&lt;b &amp; &quot;c&quot;" data-display="true" data-w="5.12ex" data-h="2ex" data-valign="-0.5ex">`);
        assert.match(buildMathImg({ hash: 'b'.repeat(32), tex: 'x', mode: 'inline-display', w: '1', h: '1', valign: '0' }), /data-display="false"/);
        assert.match(buildMathImg({ hash: 'b'.repeat(32), tex: 'x', mode: 'inline-display', w: '1', h: '1', valign: '0' }), /src="\/api\/v1\/media\/math\//);
    });
});

describe('math_svg: replaceMath', () => {
    const fakeConvert = async ({ tex, mode }) => ({ hash: mathHash({ tex, mode }), w: '1ex', h: '1ex', valign: '0' });

    it('sustituye cada formula y deja el resto del HTML intacto', async () => {
        const html = '<p>Si \\(a\\) entonces:</p><p>\\[b\\]</p>';
        const out = await replaceMath(html, fakeConvert);
        assert.equal(out.found, 2);
        assert.equal(out.converted, 2);
        assert.deepEqual(out.failed, []);
        assert.ok(out.html.startsWith('<p>Si <img class="math"'));
        assert.match(out.html, /<\/p><p><img class="math"[^>]*data-display="true"[^>]*><\/p>$/);
        assert.ok(!out.html.includes('\\['), 'no queda LaTeX');
    });

    it('si la conversion falla o lanza, esa formula conserva su LaTeX original', async () => {
        const html = 'a \\(ok\\) b \\(\\frac{\\) c $$bad$$';
        const out = await replaceMath(html, async ({ tex }) => {
            if (tex === 'bad') return null;
            if (tex.includes('frac')) throw new Error('Missing close brace');
            return fakeConvert({ tex, mode: 'inline' });
        });
        assert.equal(out.converted, 1);
        assert.deepEqual(out.failed.map((f) => f.tex), ['\\frac{', 'bad']);
        assert.match(out.failed[0].error, /Missing close brace/);
        assert.ok(out.html.includes('\\(\\frac{\\)'));
        assert.ok(out.html.includes('$$bad$$'));
        assert.ok(out.html.includes('<img class="math"'));
    });

    it('es idempotente: convertir el resultado otra vez no cambia nada', async () => {
        const first = await replaceMath('<p>\\(a\\) y \\[b\\]</p>', fakeConvert);
        const second = await replaceMath(first.html, () => assert.fail('no debe volver a convertir'));
        assert.equal(second.html, first.html);
        assert.equal(second.found, 0);
        const again = await replaceMath('<p>\\(a\\) y \\[b\\]</p>', fakeConvert);
        assert.equal(again.html, first.html, 'mismo HTML de entrada -> mismo resultado');
    });

    it('convierte una sola vez la misma formula repetida', async () => {
        let calls = 0;
        const out = await replaceMath('\\(x\\) y \\(x\\) y \\(x\\)', async (args) => { calls += 1; return fakeConvert(args); });
        assert.equal(calls, 1);
        assert.equal(out.converted, 3);
    });

    it('el conversor recibe el modo decidido por la regla bloque/linea', async () => {
        const seen = [];
        await replaceMath('<p>\\[a\\]</p><p>t \\[b\\]</p><p>\\(c\\)</p>', async (args) => { seen.push(args); return fakeConvert(args); });
        assert.deepEqual(seen, [
            { tex: 'a', mode: 'block' },
            { tex: 'b', mode: 'inline-display' },
            { tex: 'c', mode: 'inline' },
        ]);
    });
});
