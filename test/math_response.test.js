import './helpers/env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

// #Config/settings.js lee el entorno una sola vez, al cargarse el primer modulo de src/: la
// carpeta de almacenamiento y la URL publica se fijan aqui, antes de importar nada.
const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'math-resp-'));
process.env.STORAGE_DIR = storageDir;
process.env.PUBLIC_API_URL = 'https://api.eduteka.test';

const R = String.raw;
const API = '/api/v1';
const HAS_LATEX = /\\\[|\\\(|\$\$/;

// ---------------------------------------------------------------------------
// Unidad: transformPayload y el middleware con un almacen falso (sin MathJax).
// ---------------------------------------------------------------------------
describe('math_response (unidad)', async () => {
    const { createMathResponse, transformPayload, MATH_KEYS } = await import('#Middlewares/math_response.js');
    const { ApiError } = await import('#Libs/api_error.js');
    const fakeAsset = ({ tex, mode }) => ({ hash: `${mode}-${tex}`.replace(/\W/g, '').padEnd(32, '0').slice(0, 32), w: '1ex', h: '1ex', valign: '0' });

    it('solo transforma las claves de la lista blanca, en cualquier profundidad', async () => {
        const body = {
            data: [{
                id: 'q1',
                question: R`<p>\(a\)</p>`,
                topic: R`Tema \(b\)`,
                options: [{ key: 'A', text: R`\(c\)` }],
                context: { id: 'b1', text: R`<p>\[d\]</p>` },
                explanation: R`\(e\)`,
                user: { username: R`\(f\)` },
            }],
            meta: { note: R`\(g\)` },
        };
        const out = await transformPayload(body, fakeAsset);
        const q = out.data[0];
        for (const value of [q.question, q.options[0].text, q.context.text, q.explanation]) assert.match(value, /<img class="math"/);
        assert.equal(q.topic, R`Tema \(b\)`);
        assert.equal(q.user.username, R`\(f\)`);
        assert.equal(out.meta.note, R`\(g\)`);
        assert.deepEqual([...MATH_KEYS].sort(), ['explanation', 'question', 'text']);
    });

    it('no muta el original y deja intactos Date y otros objetos no planos', async () => {
        const date = new Date();
        const body = { data: { question: R`\(a\)`, created: date } };
        const out = await transformPayload(body, fakeAsset);
        assert.equal(body.data.question, R`\(a\)`);
        assert.equal(out.data.created, date);
    });

    it('registra las fallidas con el id de su pregunta y deja su LaTeX', async () => {
        const failed = [];
        const out = await transformPayload(
            { data: [{ id: 'q9', question: R`\(ok\) \(bad\)`, options: [{ key: 'A', text: R`\(bad\)` }] }] },
            ({ tex, mode }) => { if (tex === 'bad') throw new Error('boom'); return fakeAsset({ tex, mode }); },
            { failed },
        );
        assert.deepEqual(failed.map((f) => [f.question_id, f.tex]), [['q9', 'bad'], ['q9', 'bad']]);
        assert.ok(out.data[0].question.includes(R`\(bad\)`));
        assert.ok(out.data[0].options[0].text === R`\(bad\)`);
        assert.match(out.data[0].question, /<img class="math"/);
    });

    const appWith = (options, payload) => {
        const app = express();
        app.use(createMathResponse(options));
        app.get('/x', (req, res) => res.json({ data: payload, query: { ...req.query } }));
        app.get('/err', (req, res) => res.status(404).json({ error: { message: R`\(no\)`, question: R`\(no\)` } }));
        app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
            res.status(error instanceof ApiError ? error.status : 500).json({ code: error.code });
        });
        return app;
    };
    const store = { getAsset: async (input) => fakeAsset(input) };

    it('sin ?math no toca nada (misma respuesta byte a byte)', async () => {
        const payload = { question: R`\(a\)` };
        const res = await request(appWith({ store }, payload)).get('/x').expect(200);
        assert.deepEqual(res.body.data, payload);
    });

    it('?math=svg convierte y quita el parametro del query (los esquemas son estrictos)', async () => {
        const res = await request(appWith({ store }, { question: R`\(a\)` })).get('/x?math=svg&page=2').expect(200);
        assert.match(res.body.data.question, /<img class="math"/);
        assert.deepEqual(res.body.query, { page: '2' });
    });

    it('?math con otro valor -> 422', async () => {
        for (const value of ['png', '', 'svg&math=svg']) {
            await request(appWith({ store }, {})).get(`/x?math=${value}`).expect(422);
        }
    });

    it('las respuestas de error no se transforman', async () => {
        const res = await request(appWith({ store }, {})).get('/err?math=svg').expect(404);
        assert.equal(res.body.error.question, R`\(no\)`);
    });

    it('si el almacen falla, la respuesta sale igual con el LaTeX', async () => {
        const broken = { getAsset: async () => { throw new Error('disco lleno'); } };
        const res = await request(appWith({ store: broken }, { question: R`\(a\)` })).get('/x?math=svg').expect(200);
        assert.equal(res.body.data.question, R`\(a\)`);
    });

    it('agotado el presupuesto de tiempo las que faltan quedan en LaTeX', async () => {
        const slow = { getAsset: async (input) => { await new Promise((r) => setTimeout(r, 60)); return fakeAsset(input); } };
        const payload = { question: R`\(a\) \(b\) \(c\) \(d\)` };
        const res = await request(appWith({ store: slow, budgetMs: 100 }, payload)).get('/x?math=svg').expect(200);
        const converted = (res.body.data.question.match(/<img class="math"/g) ?? []).length;
        assert.ok(converted >= 1 && converted < 4, `convertidas: ${converted}`);
        assert.ok(HAS_LATEX.test(res.body.data.question));
    });
});

// ---------------------------------------------------------------------------
// Integracion: la API real con MathJax y los endpoints de preguntas y practicas.
// ---------------------------------------------------------------------------
describe('?math=svg en preguntas y practicas', () => {
    let ctx;
    let student;

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        await ctx.mongoose.connection.db.collection('questions').insertOne({
            _id: 'qm', area: 'Matemática', area_id: 'area-mat', topic: 'Álgebra', difficulty: 'Fácil', type: 'question',
            verified: true, rpta: 'B', origin: 'Oficial',
            question: R`<p>Calcula:</p><p>\[\frac{a+b}{c}\]</p><p>Si \(x=2\) y \[\sqrt{x}\] vale <img src="/images/questions/qm.png"></p>`,
            resolution: R`<p>Se obtiene \[\ce{2H2 + O2 -> 2H2O}\] porque \(x &lt; 3\).</p>`,
            options: { A: R`\(1\)`, B: R`\(\text{términos}\)`, C: R`\(\frac{\)`, D: 'sin formula', E: R`$$x^2$$` },
            options_answers: { A: 0, B: 0, C: 0, D: 0, E: 0 }, total_answers: 0,
            dependence: { id: 'bm', text: R`<p>Lectura \(\alpha\)</p>` },
            created_at: new Date(Date.UTC(2026, 0, 20)),
        });
        student = await createUser(ctx);
    });

    after(async () => {
        const { mathStore } = await import('#Libs/math_store.js');
        mathStore().close();
        await ctx.stop();
        await fs.rm(storageDir, { recursive: true, force: true });
    });

    const get = (url, user) => request(ctx.app).get(`${API}${url}`).set(user ? bearer(user) : {});

    it('sin ?math la respuesta conserva el LaTeX', async () => {
        const res = await get('/preguntas/qm').expect(200);
        assert.ok(res.body.data.question.includes(R`\[\frac{a+b}{c}\]`));
        assert.ok(!res.body.data.question.includes('<img class="math"'));
    });

    it('GET /preguntas/:id convierte pregunta, opciones y lectura', async () => {
        const res = await get('/preguntas/qm?math=svg').expect(200);
        const { question, options, context } = res.body.data;

        assert.equal((question.match(/<img class="math"/g) ?? []).length, 3);
        assert.ok(!HAS_LATEX.test(question));
        assert.match(question, /<p><img class="math"[^>]*data-display="true"[^>]*><\/p>/, 'la sola en su parrafo va en bloque');
        assert.match(question, /Si <img class="math"[^>]*data-display="false"[^>]*> y <img class="math"[^>]*data-display="false"[^>]*> vale <img src="https:\/\/eduteka\.test\/images\/questions\/qm\.png">/, 'en linea y con imagen absoluta');
        assert.match(question, /src="https:\/\/api\.eduteka\.test\/api\/v1\/media\/math\/[a-f0-9]{32}\.svg"/);
        assert.match(question, /alt="\\frac\{a\+b\}\{c\}"/);

        assert.match(options.find((o) => o.key === 'A').text, /<img class="math"/);
        assert.match(options.find((o) => o.key === 'B').text, /<img class="math"/, 'con tilde en \\text');
        assert.equal(options.find((o) => o.key === 'C').text, R`\(\frac{\)`, 'TeX invalido: se deja el LaTeX');
        assert.equal(options.find((o) => o.key === 'D').text, 'sin formula');
        assert.match(options.find((o) => o.key === 'E').text, /<img class="math"/);
        assert.match(context.text, /<img class="math"/);
    });

    it('las imagenes que devuelve se pueden descargar', async () => {
        const res = await get('/preguntas/qm?math=svg').expect(200);
        const hashes = [...res.body.data.question.matchAll(/media\/math\/([a-f0-9]{32}\.svg)/g)].map((m) => m[1]);
        assert.equal(hashes.length, 3);
        for (const file of hashes) {
            const svg = await request(ctx.app).get(`${API}/media/math/${file}`).expect(200);
            assert.match(svg.headers['content-type'], /^image\/svg\+xml/);
            assert.match(svg.body.toString(), /^<svg /);
        }
    });

    it('es estable: dos peticiones dan lo mismo y no se generan archivos nuevos', async () => {
        const first = await get('/preguntas/qm?math=svg').expect(200);
        const before = (await fs.readdir(path.join(storageDir, 'math'))).length;
        const second = await get('/preguntas/qm?math=svg').expect(200);
        assert.deepEqual(second.body, first.body);
        assert.equal((await fs.readdir(path.join(storageDir, 'math'))).length, before);
    });

    it('el listado acepta ?math=svg junto a sus filtros', async () => {
        const res = await get('/preguntas?math=svg&area=area-mat&limit=50').expect(200);
        const qm = res.body.data.find((q) => q.id === 'qm');
        assert.match(qm.question, /<img class="math"/);
        assert.equal(res.body.meta.total >= 1, true);
        assert.ok(!HAS_LATEX.test(JSON.stringify(res.body.data.filter((q) => q.id === 'qm').map((q) => q.question))));
    });

    it('?math=png -> 422', async () => {
        const res = await get('/preguntas/qm?math=png').expect(422);
        assert.equal(res.body.error.details[0].field, 'math');
    });

    it('responder: la explicacion llega convertida', async () => {
        const res = await request(ctx.app).post(`${API}/preguntas/qm/responder?math=svg`).set(bearer(student)).send({ selected: 'A' }).expect(200);
        assert.match(res.body.data.explanation, /<img class="math"/);
        assert.ok(!HAS_LATEX.test(res.body.data.explanation));
        assert.match(res.body.data.explanation, /alt="x &lt; 3"/, 'las entidades se decodifican en el TeX');
    });

    it('practica por area: las preguntas llegan convertidas', async () => {
        const res = await get('/practicas-area/preguntas?area=area-mat&count=50&math=svg', student).expect(200);
        const qm = (res.body.data.questions ?? res.body.data).find((q) => q.id === 'qm');
        assert.ok(qm, 'qm esta en la practica');
        assert.match(qm.question, /<img class="math"/);
    });
});
