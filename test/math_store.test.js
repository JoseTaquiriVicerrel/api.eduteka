import './helpers/env.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finishSvg } from '#Libs/math_render.js';
import { normalizeAccents } from '#Libs/math_svg.js';
import { MATH_VERSION, createMathRenderer, createMathStore, mathFilePath } from '#Libs/math_store.js';

const R = String.raw;
const tmpDirs = [];
const tmpDir = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'math-'));
    tmpDirs.push(dir);
    return dir;
};

// Un renderizador real (worker + MathJax) compartido por las pruebas de integracion.
const renderer = createMathRenderer({ timeoutMs: 10000 });
after(async () => {
    renderer.close();
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const storeIn = async (options = {}) => createMathStore({ dir: await tmpDir(), renderer, ...options });

describe('math_render: formulas reales del banco', () => {
    const cases = {
        frac: [R`\frac{a+b}{c}`, 'block'],
        sqrt: [R`\sqrt[3]{x^2+1}`, 'inline'],
        overline: [R`\overline{AB}`, 'inline'],
        text: [R`x=5\text{ cm}`, 'inline'],
        ce: [R`\ce{2H2 + O2 -> 2H2O}`, 'block'],
        ce2: [R`\ce{SO4^2- + Ba^2+ -> BaSO4 v}`, 'block'],
        array: [R`\begin{array}{|c|c|}\hline a & b \\ \hline c & d \\ \hline \end{array}`, 'block'],
        mathbb: [R`x\in\mathbb{R}`, 'inline'],
        widehat: [R`\widehat{ABC}`, 'inline'],
        vec: [R`\vec{v}`, 'inline'],
        // texFromHtml ya normaliza las tildes antes de llegar aqui.
        underbrace: [normalizeAccents(R`\underbrace{1+2+\cdots+n}_{n\text{ términos}}`), 'block'],
        cancel: [R`\cancel{x}+\bcancel{y}`, 'inline'],
        nested: [R`\frac{1}{1+\frac{1}{1+\frac{1}{x}}}`, 'block'],
        displayInline: [R`=4x-1`, 'inline-display'],
    };

    for (const [name, [tex, mode]] of Object.entries(cases)) {
        it(`convierte ${name} sin error`, async () => {
            const store = await storeIn();
            const asset = await store.getAsset({ tex, mode });
            assert.match(asset.hash, /^[a-f0-9]{32}$/);
            const svg = await fs.readFile(path.join(store.dir, `${asset.hash}.svg`), 'utf8');
            assert.ok(svg.startsWith('<svg '));
            assert.match(asset.w, /^[\d.]+ex$/);
            assert.match(asset.h, /^[\d.]+ex$/);
            assert.match(asset.valign, /^-?[\d.]+(ex)?$/);
            // Contrato del SVG: px, sin style, sin <text>, color heredado.
            assert.match(svg, /width="[\d.]+px"/);
            assert.ok(!svg.includes('vertical-align'));
            assert.ok(!svg.includes('<text'));
            assert.ok(svg.includes('currentColor'));
            assert.ok(!/<script|href=/.test(svg));
        });
    }

    it('las tablas llevan fill="none" en marcos y lineas (sin la hoja CSS se verian negras)', async () => {
        const store = await storeIn();
        const { hash } = await store.getAsset({ tex: cases.array[0], mode: 'block' });
        const svg = await fs.readFile(path.join(store.dir, `${hash}.svg`), 'utf8');
        const frames = svg.match(/<(?:rect|line)\b[^>]*data-(?:frame|line)[^>]*>/g) ?? [];
        assert.ok(frames.length > 0, 'la tabla tiene marco o lineas');
        for (const tag of frames) assert.match(tag, /fill="none"[^>]*stroke-width="70"|stroke-width="70"[^>]*fill="none"/);
    });

    it('las tildes dentro de \\text{} salen como trazados, no como <text>', async () => {
        const store = await storeIn();
        const { hash } = await store.getAsset({ tex: R`\text{t\'erminos \~n \"u}`, mode: 'inline' });
        const svg = await fs.readFile(path.join(store.dir, `${hash}.svg`), 'utf8');
        assert.ok(!svg.includes('<text'));
    });
});

describe('math_store: fallos controlados', () => {
    it('TeX invalido y comando desconocido lanzan (no se dibujan en rojo)', async () => {
        const store = await storeIn();
        await assert.rejects(store.getAsset({ tex: R`\frac{`, mode: 'inline' }), /brace|Missing/i);
        await assert.rejects(store.getAsset({ tex: R`\comandoinexistente{x}`, mode: 'inline' }), /undefined|Undefined/i);
        assert.equal(store.stats.failed, 2);
        assert.deepEqual(await fs.readdir(store.dir).catch(() => []), [], 'un fallo no deja archivos');
    });

    it('el mismo fallo se reintenta (no se cachea)', async () => {
        const store = await storeIn();
        await assert.rejects(store.getAsset({ tex: R`\frac{`, mode: 'inline' }));
        await assert.rejects(store.getAsset({ tex: R`\frac{`, mode: 'inline' }));
        assert.equal(store.stats.failed, 2);
    });

    it('finishSvg rechaza script, handlers, href externo, <text>, errores y tamanos excesivos', () => {
        const ok = '<svg style="vertical-align: -0.5ex;" xmlns="http://www.w3.org/2000/svg" width="2ex" height="1ex" viewBox="0 0 1 1"><g/></svg>';
        assert.deepEqual(finishSvg(ok).valign, '-0.5ex');
        for (const bad of [
            ok.replace('<g/>', '<script>alert(1)</script>'),
            ok.replace('<g/>', '<g onclick="x()"/>'),
            ok.replace('<g/>', '<a href="http://evil.test"/>'),
            ok.replace('<g/>', '<text>x</text>'),
            ok.replace('<g/>', '<g fill="red"/>'),
            ok.replace('<g/>', '<foreignObject/>'),
            ok.replace('<g/>', `<!--${'x'.repeat(301 * 1024)}-->`),
            '<div>no es svg</div>',
        ]) assert.throws(() => finishSvg(bad));
        assert.doesNotThrow(() => finishSvg(ok.replace('<g/>', '<use href="#a"/>')));
    });
});

describe('math_store: cache e idempotencia', () => {
    it('mismo TeX -> mismo archivo y no se reescribe', async () => {
        const store = await storeIn();
        const first = await store.getAsset({ tex: R`\frac{1}{2}`, mode: 'block' });
        const file = path.join(store.dir, `${first.hash}.svg`);
        const mtime = (await fs.stat(file)).mtimeMs;

        const second = await store.getAsset({ tex: R`\frac{1}{2}`, mode: 'block' });
        assert.deepEqual(second, first);
        assert.equal((await fs.stat(file)).mtimeMs, mtime);
        assert.deepEqual({ generated: store.stats.generated, memoryHits: store.stats.memoryHits }, { generated: 1, memoryHits: 1 });
        assert.deepEqual((await fs.readdir(store.dir)).sort(), [`${first.hash}.json`, `${first.hash}.svg`]);
    });

    it('otra instancia (arranque en frio) lee de disco sin volver a convertir', async () => {
        const dir = await tmpDir();
        const a = createMathStore({ dir, renderer });
        const asset = await a.getAsset({ tex: 'x^2', mode: 'inline' });

        const b = createMathStore({ dir, renderer: { render: () => assert.fail('no debe convertir'), close() {} } });
        assert.deepEqual(await b.getAsset({ tex: 'x^2', mode: 'inline' }), asset);
        assert.equal(b.stats.diskHits, 1);
    });

    it('modo o version distintos -> archivo distinto', async () => {
        const dir = await tmpDir();
        const a = createMathStore({ dir, renderer });
        const block = await a.getAsset({ tex: 'x^2', mode: 'block' });
        const inline = await a.getAsset({ tex: 'x^2', mode: 'inline' });
        const v2 = await createMathStore({ dir, renderer, version: `${MATH_VERSION}-otra` }).getAsset({ tex: 'x^2', mode: 'block' });
        assert.equal(new Set([block.hash, inline.hash, v2.hash]).size, 3);
        assert.equal((await fs.readdir(dir)).filter((f) => f.endsWith('.svg')).length, 3);
    });

    it('inline-display antepone \\displaystyle (el SVG difiere del inline)', async () => {
        const dir = await tmpDir();
        const store = createMathStore({ dir, renderer });
        const tex = R`\sum_{i=1}^{n} \frac{1}{i}`;
        const inline = await store.getAsset({ tex, mode: 'inline' });
        const display = await store.getAsset({ tex, mode: 'inline-display' });
        assert.notEqual(inline.h, display.h);
    });

    it('peticiones simultaneas de la misma formula: una conversion y un archivo integro', async () => {
        const dir = await tmpDir();
        let calls = 0;
        const counting = { render: (input) => { calls += 1; return renderer.render(input); }, close() {} };
        const store = createMathStore({ dir, renderer: counting });
        const results = await Promise.all(Array.from({ length: 10 }, () => store.getAsset({ tex: R`\sqrt{2}`, mode: 'block' })));
        assert.equal(calls, 1);
        assert.equal(new Set(results.map((r) => r.hash)).size, 1);
        const files = await fs.readdir(dir);
        assert.ok(files.every((f) => !f.endsWith('.tmp')), 'no quedan temporales');
        assert.match(await fs.readFile(path.join(dir, `${results[0].hash}.svg`), 'utf8'), /<\/svg>$/);
    });

    it('el LRU descarta lo mas antiguo', async () => {
        const store = await storeIn({ lruSize: 2 });
        for (const tex of ['a', 'b', 'c']) await store.getAsset({ tex, mode: 'inline' });
        assert.equal(store.lruSize(), 2);
        await store.getAsset({ tex: 'a', mode: 'inline' });
        assert.equal(store.stats.diskHits, 1, 'a salio del LRU y se leyo de disco');
    });
});

describe('math_store: worker', () => {
    const hangUrl = new URL('./helpers/math_hang_worker.js', import.meta.url);

    it('un TeX que cuelga vence el timeout y el siguiente se atiende con un worker nuevo', async () => {
        const hanging = createMathRenderer({ timeoutMs: 300, workerUrl: hangUrl });
        try {
            const started = Date.now();
            await assert.rejects(hanging.render({ tex: 'hang', display: false }), /timeout/);
            assert.ok(Date.now() - started < 3000);
            const ok = await hanging.render({ tex: 'x', display: false });
            assert.equal(ok.w, '1ex');
        } finally {
            hanging.close();
        }
    });

    it('las peticiones en cola se atienden en orden y la que cuelga no arrastra a las demas', async () => {
        const hanging = createMathRenderer({ timeoutMs: 300, workerUrl: hangUrl });
        try {
            const results = await Promise.allSettled([
                hanging.render({ tex: 'a', display: false }),
                hanging.render({ tex: 'hang', display: false }),
                hanging.render({ tex: 'b', display: false }),
            ]);
            assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
        } finally {
            hanging.close();
        }
    });

    it('el arranque lento del worker no cuenta contra el timeout por formula', async () => {
        // Arranca en ~700 ms y el timeout por formula es de 300: debe responder igual.
        const slow = createMathRenderer({ timeoutMs: 300, workerUrl: new URL('./helpers/math_slow_start_worker.js', import.meta.url) });
        try {
            const result = await slow.render({ tex: 'x', display: false });
            assert.equal(result.w, '1ex');
        } finally {
            slow.close();
        }
    });

    it('si el worker nunca avisa que esta listo, falla por el plazo de arranque (no se cuelga)', async () => {
        process.env.MATH_NEVER_READY = '1';
        const never = createMathRenderer({ timeoutMs: 300, startupMs: 300, workerUrl: new URL('./helpers/math_slow_start_worker.js', import.meta.url) });
        try {
            await assert.rejects(never.render({ tex: 'x', display: false }), /no arranco/);
        } finally {
            delete process.env.MATH_NEVER_READY;
            never.close();
        }
    });

    it('close() rechaza lo pendiente', async () => {
        const hanging = createMathRenderer({ timeoutMs: 5000, workerUrl: hangUrl });
        const pending = hanging.render({ tex: 'hang', display: false });
        hanging.close();
        await assert.rejects(pending, /cerrado/);
    });
});

describe('math_store: seguridad del nombre', () => {
    it('mathFilePath solo acepta <32 hex>.svg', () => {
        const dir = path.join(os.tmpdir(), 'x');
        assert.equal(mathFilePath('a'.repeat(32) + '.svg', dir), path.join(dir, 'a'.repeat(32) + '.svg'));
        for (const bad of ['../etc/passwd', `..%2f${'a'.repeat(28)}.svg`, 'a'.repeat(32) + '.json', 'A'.repeat(32) + '.svg', 'a'.repeat(31) + '.svg', 'a'.repeat(32) + '.svg/..', '']) {
            assert.equal(mathFilePath(bad, dir), null, bad);
        }
    });
});
