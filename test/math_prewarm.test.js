import './helpers/env.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp } from './helpers/boot.js';

const R = String.raw;

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'math-prewarm-'));
process.env.STORAGE_DIR = storageDir;

describe('precalentamiento por senal de contenido', () => {
    let ctx;
    let prewarm;
    let events;
    let storeModule;
    let catalog;
    let store;

    const cached = async (tex, mode = 'inline') => {
        const hash = (await import('#Libs/math_svg.js')).mathHash({ tex, mode, version: storeModule.MATH_VERSION });
        return fs.access(path.join(store.dir, `${hash}.svg`)).then(() => true, () => false);
    };

    before(async () => {
        ctx = await bootTestApp();
        [prewarm, events, storeModule, catalog] = await Promise.all([
            import('#Libs/math_prewarm.js'),
            import('#Libs/content_events.js'),
            import('#Libs/math_store.js'),
            import('#Libs/math_catalog.js'),
        ]);
        store = storeModule.createMathStore();
        const { db } = ctx.mongoose.connection;

        await db.collection('prospects').insertOne({ _id: 'prp', exam_unique: false });
        await db.collection('questions').insertOne({ _id: 'qp1', verified: false, rpta: 'A', question: R`<p>\(pa\)</p>`, options: { A: R`\(pb\)` } });
        await db.collection('exams').insertMany([
            { _id: 'e-ok', verified: true, general_items: [{ id: 'g', question: R`<p>\begin{array}{|c|}\hline x \\ \hline \end{array}</p>`, options: { A: R`\(ea\)` } }] },
            { _id: 'e-no', verified: false, general_items: [{ id: 'g', question: R`\(noverif\)` }] },
        ]);
        await db.collection('simulacrums').insertMany([
            { _id: 's-prosp', slug: 'sim-prosp', verified: true, state: true, general: false, prospect: 'prp', areas: { A: { questions: [{ itype: 'question', id: 'qp1' }] } } },
            { _id: 's-borrador', slug: 'sim-borrador', verified: true, state: false, general_items: [{ id: 'u', question: R`\(draft\)` }] },
        ]);
    });

    after(async () => {
        store.close();
        await events.closeContentBus();
        await ctx.stop();
        await fs.rm(storageDir, { recursive: true, force: true });
    });

    it('collectFormulas acepta el id del simulacro', async () => {
        const scan = await catalog.collectFormulas({ sources: ['simulacra'], simulacrum: 's-prosp' });
        assert.equal(scan.documents, 1);
        assert.deepEqual([...scan.formulas.values()].map((f) => f.tex).sort(), ['pa', 'pb']);
    });

    it('una senal de simulacro de prospecto deja en cache lo que sirve el intento', async () => {
        assert.equal(await cached('pa'), false);
        const summary = await prewarm.prewarmContent({ kind: 'simulacrum', id: 's-prosp' }, store);
        assert.equal(summary.failed, 0);
        assert.equal(summary.generated, 2);
        assert.equal(await cached('pa'), true);
        assert.equal(await cached('pb'), true);
    });

    it('una senal de examen convierte tambien las tablas sin delimitadores', async () => {
        const summary = await prewarm.prewarmContent({ kind: 'exam', id: 'e-ok' }, store);
        assert.equal(summary.failed, 0);
        assert.equal(summary.formulas, 2);
        assert.equal(await cached('ea'), true);
    });

    it('un contenido sin verificar o sin publicar se omite sin lanzar', async () => {
        assert.equal(await prewarm.prewarmContent({ kind: 'exam', id: 'e-no' }, store), null);
        assert.equal(await prewarm.prewarmContent({ kind: 'simulacrum', id: 's-borrador' }, store), null);
        assert.equal(await prewarm.prewarmContent({ kind: 'exam', id: 'no-existe' }, store), null);
        assert.equal(await cached('noverif'), false);
    });

    it('el bus valida el contrato y entrega la senal a quien se suscribe', async () => {
        assert.equal(events.publishContentLocal({ v: 2, type: 'content', kind: 'exam', id: 'x' }), false);
        assert.equal(events.publishContentLocal({ v: 1, type: 'content', kind: 'otro', id: 'x' }), false);
        assert.equal(events.publishContentLocal({ v: 1, type: 'content', kind: 'exam' }), false);
        assert.equal(events.parseContentSignal('{no es json'), null);

        const received = [];
        const stop = events.subscribeContent((signal) => { received.push(signal); });
        assert.equal(events.publishContentLocal({ v: 1, type: 'content', kind: 'simulacrum', id: 's1', slug: 'uno', extra: 'ignorado' }), true);
        await new Promise((resolve) => setImmediate(resolve));
        stop();
        assert.deepEqual(received, [{ v: 1, type: 'content', kind: 'simulacrum', id: 's1', slug: 'uno', emitted_at: null }]);
    });

    it('la cola deduplica por kind:id', async () => {
        const first = prewarm.enqueuePrewarm({ kind: 'exam', id: 'e-no' });
        const second = prewarm.enqueuePrewarm({ kind: 'exam', id: 'e-no' });
        assert.equal(first, second, 'misma corrida de la cola');
        await first;
    });
});
