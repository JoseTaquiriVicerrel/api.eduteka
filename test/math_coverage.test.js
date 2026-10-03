import './helpers/env.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedExams, seedSimulacra } from './helpers/seed.js';

// Red de seguridad de ?math=svg: cada endpoint que entrega HTML de preguntas se prueba con
// LaTeX en TODOS los campos de texto de la fuente. Si manana se añade un campo HTML nuevo
// (o un endpoint) y no esta en la lista blanca de #Middlewares/math_response.js, esta prueba
// falla porque queda LaTeX sin convertir en la respuesta.

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'math-cov-'));
process.env.STORAGE_DIR = storageDir;
process.env.PUBLIC_API_URL = 'https://api.eduteka.test';

const R = String.raw;
const API = '/api/v1';
const person = { fullname: 'Ana Pérez López', dni: '12345678' };
const LATEX = /\\\[|\\\(|\$\$/;

/** Recorre toda la respuesta y devuelve { path, value } de cada texto que aun lleva LaTeX. */
const leftovers = (node, where = '$') => {
    if (typeof node === 'string') return LATEX.test(node) ? [{ where, value: node.slice(0, 80) }] : [];
    if (Array.isArray(node)) return node.flatMap((item, i) => leftovers(item, `${where}[${i}]`));
    if (node && typeof node === 'object') return Object.entries(node).flatMap(([key, value]) => leftovers(value, `${where}.${key}`));
    return [];
};
const countImgs = (node) => JSON.stringify(node).match(/<img class=\\"math\\"/g)?.length ?? 0;
const assertConverted = (body, minimum) => {
    assert.deepEqual(leftovers(body), [], 'queda LaTeX sin convertir (clave HTML fuera de la lista blanca?)');
    assert.ok(countImgs(body) >= minimum, `se esperaban >= ${minimum} formulas convertidas y hay ${countImgs(body)}`);
};

describe('?math=svg: cobertura de todos los endpoints con HTML de preguntas', () => {
    let ctx;
    let student;
    let teacher;

    before(async () => {
        ctx = await bootTestApp();
        const { db } = ctx.mongoose.connection;
        await seedCatalog(ctx);
        await seedExams(ctx);
        await seedSimulacra(ctx);

        // Pregunta practicable con LaTeX en todos los campos HTML.
        await db.collection('questions').insertOne({
            _id: 'qx', area: 'Matemática', area_id: 'area-mat', topic: 'Álgebra', difficulty: 'Fácil', type: 'question',
            verified: true, rpta: 'B', origin: 'Oficial',
            question: R`<p>Enunciado \(a_1\)</p>`, resolution: R`<p>Solución \[b^2\]</p>`,
            options: { A: R`\(c\)`, B: R`\(d\)`, C: R`\(e\)`, D: R`\(f\)`, E: R`\(g\)` },
            options_answers: { A: 0, B: 0, C: 0, D: 0, E: 0 }, total_answers: 0,
            dependence: { id: 'bx', text: R`<p>Lectura \(\beta\)</p>` },
            created_at: new Date(Date.UTC(2026, 1, 1)),
        });
        await db.collection('userquestionslists').insertOne({
            _id: 'px', name: 'Con formulas', slug: 'con-formulas', public: true,
            questions: ['qx'], areas: [{ name: 'Matemática', count: 1 }], count_questions: 1, created_at: new Date(Date.UTC(2026, 1, 2)),
        });

        // Examen: LaTeX en pregunta, opciones, resolucion y lectura.
        await db.collection('exams').updateOne({ _id: 'e1' }, {
            $set: {
                'general_items.0.question': R`<p>Examen \(x\)</p>`,
                'general_items.0.options': { A: R`\(1\)`, B: R`\(2\)`, C: R`\(3\)` },
                'general_items.0.resolution': R`<p>Exp \[y\]</p>`,
                'general_items.1.text': R`<p>Lectura \(\gamma\)</p>`,
            },
        });

        // Simulacro: items propios con LaTeX (banco general y areas).
        const item = (id, area, rpta) => ({
            itype: 'question', id, area, rpta, question: R`<p>Sim ${id} \(s\)</p>`,
            options: { A: R`\(1\)`, B: R`\(2\)`, C: R`\(3\)`, D: R`\(4\)` }, resolution: R`<p>Exp \[t\]</p>`, topic: 'Tema',
        });
        const items = [
            { itype: 'reading_section', id: 'r1', title: 'Lectura', text: R`<p>Lectura sim \(\delta\)</p>`, area: 'Lenguaje' },
            item('a1', 'Matemática', 'A'),
            item('a2', 'Matemática', 'B'),
        ];
        await db.collection('simulacrums').updateOne({ _id: 's-simulacro-general' }, {
            $set: { general_items: items, 'areas.I.questions': items.filter((i) => i.itype === 'question') },
        });

        student = await createUser(ctx);
        teacher = await createUser(ctx, { account_type: 'Profesor' });
    });

    after(async () => {
        const { mathStore } = await import('#Libs/math_store.js');
        mathStore().close();
        await ctx.stop();
        await fs.rm(storageDir, { recursive: true, force: true });
    });

    const get = (url, user) => request(ctx.app).get(`${API}${url}`).set(user ? bearer(user) : {});
    const post = (url, user, body = {}) => request(ctx.app).post(`${API}${url}`).set(user ? bearer(user) : {}).send(body);

    it('sin ?math el LaTeX llega tal cual (control de la prueba)', async () => {
        const res = await get('/preguntas/qx').expect(200);
        assert.ok(leftovers(res.body).length > 0);
    });

    it('preguntas: detalle, listado y responder', async () => {
        assertConverted((await get('/preguntas/qx?math=svg').expect(200)).body, 7);
        assertConverted((await get('/preguntas?math=svg&limit=50').expect(200)).body.data.filter((q) => q.id === 'qx'), 7);
        assertConverted((await post('/preguntas/qx/responder?math=svg', student, { selected: 'A' }).expect(200)).body, 1);
    });

    it('practicas: por area y detalle de una practica guardada', async () => {
        assertConverted((await get('/practicas-area/preguntas?area=area-mat&count=50&math=svg', student).expect(200)).body.data, 1);
        const detail = await get('/practicas/con-formulas?math=svg', student).expect(200);
        assertConverted(detail.body, 7);
    });

    it('practicas: finalizar entrega las explicaciones convertidas', async () => {
        const res = await post('/practicas/con-formulas/finalizar?math=svg', student, { answers: { qx: 'A' }, time: 5 });
        assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 200));
        assertConverted(res.body, 1);
    });

    it('examenes: el docente ve pregunta, opciones, lectura y explicacion convertidas', async () => {
        const res = await get('/examenes/unmsm-2025-i?area=A&math=svg', teacher).expect(200);
        const items = res.body.data.items;
        assert.ok(items.some((i) => i.explanation), 'el docente recibe explicaciones');
        assertConverted(items, 6);
    });

    it('simulacros: iniciar (items sin clave), finalizar y solucionario', async () => {
        const user = await createUser(ctx);
        await post('/simulacros/simulacro-general/inscribirme', user, person).expect(201);
        const started = await post('/simulacros/simulacro-general/iniciar?math=svg', user).expect(200);
        assertConverted(started.body.data.items, 6);

        await post(`/simulacros/intentos/${started.body.data.attempt_id}/finalizar`, user, {}).expect(200);
        const solutions = await get('/simulacros/simulacro-general/solucionario?math=svg', user).expect(200);
        assertConverted(solutions.body.data.items, 6);
        assert.ok(solutions.body.data.items.some((i) => i.explanation), 'el solucionario trae explicaciones');
    });

    it('mis-listas: el detalle de una lista propia', async () => {
        const created = await post('/mis-listas', student, { name: 'Mi lista', question_ids: ['qx'] }).expect(201);
        const res = await get(`/mis-listas/${created.body.data.id}?math=svg`, student).expect(200);
        assertConverted(res.body.data.questions, 6);
    });

    it('el parametro tambien se acepta (y se ignora) en endpoints sin HTML', async () => {
        await get('/examenes?math=svg').expect(200);
        await get('/simulacros?math=svg', student).expect(200);
        await get('/mis-listas?math=svg', student).expect(200);
    });
});
