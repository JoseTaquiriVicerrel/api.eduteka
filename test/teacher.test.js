import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { makeFilesTree } from './helpers/files.js';
import { bearer, createUser, seedCatalog } from './helpers/seed.js';

const API = '/api/v1';
const binary = (res, callback) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
        const body = Buffer.concat(chunks);
        callback(null, String(res.headers['content-type']).includes('json') ? JSON.parse(body.toString('utf8')) : body);
    });
};

describe('docente: resumen y mis materiales', () => {
    let ctx;
    let tree;
    let teacher;
    let other;
    let student;

    before(async () => {
        tree = makeFilesTree();
        fs.mkdirSync(path.join(tree.root, 'storage', 'materiales'), { recursive: true });
        fs.writeFileSync(path.join(tree.root, 'storage', 'materiales', 'm1.pdf'), Buffer.from('%PDF-1.4 material uno'));
        fs.writeFileSync(path.join(tree.root, 'storage', 'materiales', 'm2.docx'), Buffer.from('docx material dos'));

        ctx = await bootTestApp({ FILES_ROOT_DIR: tree.root });
        await seedCatalog(ctx);
        teacher = await createUser(ctx, { account_type: 'Profesor', teaching_area: 'area-mat' });
        other = await createUser(ctx, { account_type: 'Profesor', teaching_area: 'area-mat' });
        student = await createUser(ctx);

        const db = (name) => ctx.mongoose.connection.db.collection(name);
        const mine = teacher.session.user.id;
        const theirs = other.session.user.id;
        await db('materials').insertMany([
            { _id: 'm1', title: 'Guia de algebra', created_by: mine, state: true, file_path: 'storage/materiales/m1.pdf', created_at: new Date('2026-03-02') },
            { _id: 'm2', title: 'Practica: ecuaciones', created_by: mine, state: false, file_path: 'storage/materiales/m2.docx', created_at: new Date('2026-03-01') },
            { _id: 'm3', title: 'Borrador sin archivo', created_by: mine, state: true, step: 2, created_at: new Date('2026-03-03') },
            { _id: 'm4', title: 'Archivo perdido', created_by: mine, state: true, file_path: 'storage/materiales/no-existe.pdf', created_at: new Date('2026-02-01') },
            { _id: 'm9', title: 'De otro docente', created_by: theirs, state: true, file_path: 'storage/materiales/m1.pdf', created_at: new Date('2026-03-04') },
        ]);
        await db('templates').insertMany([
            { _id: 't1', created_by: mine, name: 'Formato A' },
            { _id: 't2', created_by: mine, name: 'Formato B' },
            { _id: 't9', created_by: theirs, name: 'Ajeno' },
        ]);
        await db('userquestionslists').insertMany([
            { _id: 'l1', name: 'Repaso 1', user: mine, questions: [] },
            { _id: 'l2', name: 'Repaso 2', user: mine, questions: [] },
            { _id: 'l3', name: 'Repaso 3', user: mine, questions: [] },
            { _id: 'l9', name: 'Ajena', user: theirs, questions: [] },
        ]);
        await db('questions').insertMany([
            { _id: 'dq1', origin: 'Docente', created_by: mine, area_id: 'area-mat', verified: true, rpta: 'A', question: '<p>Propia 1</p>', options: { A: 'a', B: 'b' } },
            { _id: 'dq2', origin: 'Docente', created_by: mine, area_id: 'area-mat', verified: true, rpta: 'A', question: '<p>Propia 2</p>', options: { A: 'a', B: 'b' } },
            { _id: 'dq9', origin: 'Docente', created_by: theirs, area_id: 'area-mat', verified: true, rpta: 'A', question: '<p>Ajena</p>', options: { A: 'a', B: 'b' } },
        ]);
    });
    after(async () => {
        await ctx.stop();
        tree.cleanup();
    });
    beforeEach(() => ctx.kv.flushMemory());

    const get = (route, user) => request(ctx.app).get(`${API}${route}`).set(user ? bearer(user) : {});

    describe('GET /docente/resumen', () => {
        it('exige sesion y cuenta de Profesor', async () => {
            await get('/docente/resumen').expect(401);
            await get('/docente/resumen', student).expect(403);
        });

        it('cuenta solo lo propio y trae los topes del plan', async () => {
            const res = await get('/docente/resumen', teacher).expect(200);

            assert.deepEqual(res.body.data, {
                questions: { count: 2 },
                practices: { count: 3, max_questions: 30 },
                // m1 (activo) + m2 (desactivado) + m4 (activo, archivo perdido): el borrador sin archivo no cuenta.
                materials: { count: 3, active: 2, limit: 20 },
                templates: { count: 2, limit: 10 },
            });
        });

        it('una cuenta sin nada devuelve ceros', async () => {
            const empty = await createUser(ctx, { account_type: 'Profesor', teaching_area: 'area-mat' });
            const res = await get('/docente/resumen', empty).expect(200);

            assert.equal(res.body.data.questions.count, 0);
            assert.equal(res.body.data.practices.count, 0);
            assert.equal(res.body.data.materials.count, 0);
            assert.equal(res.body.data.templates.count, 0);
        });
    });

    describe('GET /mis-materiales', () => {
        it('exige sesion', async () => {
            await get('/mis-materiales').expect(401);
            await get('/mis-materiales/m1/descargar').expect(401);
        });

        it('lista todos los suyos, tambien los desactivados, sin borradores ni ajenos', async () => {
            const res = await get('/mis-materiales', teacher).expect(200);
            const byId = Object.fromEntries(res.body.data.map((item) => [item.id, item]));

            assert.deepEqual(res.body.data.map((item) => item.id), ['m1', 'm2', 'm4']);
            assert.equal(byId.m1.active, true);
            assert.equal(byId.m2.active, false);
            assert.equal(byId.m1.type_file, 'pdf');
            assert.equal(byId.m2.type_file, 'docx');
            assert.equal(byId.m1.size, '%PDF-1.4 material uno'.length);
            assert.match(byId.m1.download_url, /\/api\/v1\/mis-materiales\/m1\/descargar$/);
            assert.equal(byId.m1.created_at, '2026-03-02T00:00:00.000Z');
        });

        it('un archivo que falta en el servidor se marca no disponible y sin enlace', async () => {
            const res = await get('/mis-materiales', teacher).expect(200);
            const lost = res.body.data.find((item) => item.id === 'm4');

            assert.equal(lost.available, false);
            assert.equal(lost.download_url, null);
            assert.equal(lost.size, null);
        });

        it('trae el uso de la cuota con los desactivados incluidos', async () => {
            const res = await get('/mis-materiales', teacher).expect(200);

            assert.deepEqual(res.body.meta.quota, { limit: 20, used: 3, active: 2, remaining: 17 });
            assert.equal(res.body.meta.total, 3);
        });

        it('pagina', async () => {
            const res = await get('/mis-materiales?page=2&limit=2', teacher).expect(200);

            assert.deepEqual(res.body.data.map((item) => item.id), ['m4']);
            assert.equal(res.body.meta.has_more, false);
        });

        it('un docente nunca ve los materiales de otro', async () => {
            const res = await get('/mis-materiales', other).expect(200);

            assert.deepEqual(res.body.data.map((item) => item.id), ['m9']);
        });
    });

    describe('GET /mis-materiales/:id/descargar', () => {
        const download = (id, user) => get(`/mis-materiales/${id}/descargar`, user).buffer(true).parse(binary);

        it('entrega el archivo al dueño y deja constancia', async () => {
            const res = await download('m1', teacher).expect(200);

            assert.equal(res.body.toString(), '%PDF-1.4 material uno');
            assert.match(res.headers['content-disposition'], /attachment/);
            const log = await eventually(() => ctx.mongoose.connection.db.collection('downloads').findOne({ resource_id: 'm1' }));
            assert.equal(log.source, 'material');
            assert.equal(log.resource_type, 'material');
            assert.equal(log.user_account_type, 'Profesor');
        });

        it('tambien entrega uno desactivado', async () => {
            const res = await download('m2', teacher).expect(200);

            assert.equal(res.body.toString(), 'docx material dos');
        });

        it('el material de otro, un borrador, uno sin archivo o uno inexistente responden 404', async () => {
            for (const id of ['m9', 'm3', 'm4', 'no-existe']) await download(id, teacher).expect(404);
            await download('m1', other).expect(404);
        });
    });
});

async function eventually(read, tries = 30) {
    for (let i = 0; i < tries; i += 1) {
        const value = await read();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('no llego a registrarse');
}
