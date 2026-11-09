import './helpers/env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildListHtml, inlineImages } from '#Modules/lists/list.pdf_html.js';
import { DocsUnavailableError, printPdf } from '#Libs/docs_client.js';

// 1x1 PNG y un SVG de formula de prueba.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
const HASH = 'a'.repeat(32);

describe('HTML del PDF de una lista', () => {
    let publicDir;
    let mathDir;
    let secret;
    before(async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edk-list-pdf-'));
        publicDir = path.join(root, 'public');
        mathDir = path.join(root, 'math');
        await fs.mkdir(path.join(publicDir, 'images', 'questions'), { recursive: true });
        await fs.mkdir(mathDir, { recursive: true });
        await fs.writeFile(path.join(publicDir, 'images', 'questions', 'q1.png'), PNG);
        await fs.writeFile(path.join(mathDir, `${HASH}.svg`), SVG);
        secret = path.join(root, 'secreto.png');
        await fs.writeFile(secret, PNG);
    });
    after(async () => { await fs.rm(path.dirname(publicDir), { recursive: true, force: true }); });

    const convert = async () => ({ hash: HASH, w: '2ex', h: '1ex', valign: '-0.2ex' });
    const list = (overrides = {}) => ({
        title: 'Mi lista <b>especial</b>',
        description: 'Repaso & práctica',
        includeAnswers: false,
        questions: [
            { area: 'Matemática', question: '<p>Calcula \\(x^2\\) <img src="/images/questions/q1.png"></p>', options: [{ key: 'A', text: '\\(1\\)' }, { key: 'B', text: '2' }], correct: 'A' },
            { area: 'Lenguaje', question: '<p>Sin formula</p>', options: [{ key: 'A', text: 'si' }], correct: 'B' },
        ],
        ...overrides,
    });

    it('incrusta imagenes y formulas como data URI: el PDF no depende de la red', async () => {
        const html = await buildListHtml(list(), { convert, publicDir, mathDir });
        assert.match(html, /src="data:image\/png;base64,/);
        assert.match(html, /class="math" src="data:image\/svg\+xml;base64,/);
        assert.doesNotMatch(html, /\\\(/, 'no queda LaTeX sin convertir');
        assert.doesNotMatch(html, /https?:\/\/(cdn|fonts)\./, 'nada de CDN');
    });

    it('escapa el titulo y la descripcion, numera y muestra el area', async () => {
        const html = await buildListHtml(list(), { convert, publicDir, mathDir });
        assert.match(html, /Mi lista &lt;b&gt;especial&lt;\/b&gt;/);
        assert.match(html, /Repaso &amp; práctica/);
        assert.match(html, /<span class="number">2\.<\/span>/);
        assert.match(html, /class="meta">Matemática</);
    });

    it('la clave de respuestas solo si se pide', async () => {
        assert.doesNotMatch(await buildListHtml(list(), { convert, publicDir, mathDir }), /Clave de respuestas/);
        const html = await buildListHtml(list({ includeAnswers: true }), { convert, publicDir, mathDir });
        assert.match(html, /Clave de respuestas/);
        assert.match(html, /1\. <strong>A<\/strong>.*2\. <strong>B<\/strong>/s);
    });

    it('quita scripts, manejadores on* y URLs javascript: del HTML de las preguntas', async () => {
        const html = await buildListHtml(list({ questions: [{
            question: '<p onclick="alert(1)">x<script>alert(2)</script><a href="javascript:alert(3)">y</a><img src="/images/questions/q1.png" onerror="alert(4)"></p>',
            options: [{ key: 'A', text: '<script src="https://evil.test/x.js"></script>ok' }],
        }] }), { convert, publicDir, mathDir });
        assert.doesNotMatch(html, /<script/i);
        assert.doesNotMatch(html, /\son(click|error)=/i);
        assert.doesNotMatch(html, /javascript:/i);
    });

    it('no sale de la carpeta publica; lo que falta queda con la URL absoluta de la web', async () => {
        const out = await inlineImages([
            '<img src="/../secreto.png">',
            '<img src="/images/%2e%2e/%2e%2e/secreto.png">',
            '<img src="/images/questions/no-existe.png">',
            `<img src="/api/v1/media/math/${'b'.repeat(32)}.svg">`,
        ].join(''), { publicDir, mathDir });
        assert.doesNotMatch(out, /data:image\/png/, 'nada de fuera de la carpeta publica');
        assert.match(out, /src="https:\/\/eduteka\.test\/images\/questions\/no-existe\.png"/);
        assert.match(out, /src="https:\/\/eduteka\.test\/api\/v1\/media\/math\/b+\.svg"/);
    });
});

describe('cliente de edk-docs en la API', () => {
    it('con las colas apagadas lanza DocsUnavailableError sin tocar nada', async () => {
        await assert.rejects(printPdf({ html: '<p>x</p>', title: 't' }), DocsUnavailableError);
    });
});
