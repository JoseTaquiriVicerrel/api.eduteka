import './helpers/env.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp } from './helpers/boot.js';

const run = promisify(execFile);
const R = String.raw;

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'math-warm-'));
process.env.STORAGE_DIR = storageDir;
const mathDir = path.join(storageDir, 'math');

describe('precalentamiento y limpieza de la cache de formulas', () => {
    let ctx;
    let catalog;
    let admin;
    let storeModule;

    before(async () => {
        ctx = await bootTestApp();
        [catalog, admin, storeModule] = await Promise.all([
            import('#Libs/math_catalog.js'),
            import('#Libs/math_cache_admin.js'),
            import('#Libs/math_store.js'),
        ]);
        const { db } = ctx.mongoose.connection;

        await db.collection('questions').insertMany([
            // Practicable: cuenta (pregunta, opciones, resolucion y lectura enlazada).
            { _id: 'w1', verified: true, rpta: 'A', question: R`<p>\(a\) y \(a\)</p>`, resolution: R`<p>\[b\]</p>`, options: { A: R`\(c\)`, B: 'sin' }, dependence: { id: 'd', text: R`<p>\(d\)</p>` } },
            // No practicables: no cuentan.
            { _id: 'w2', verified: false, rpta: 'A', question: R`\(no1\)`, options: {} },
            { _id: 'w3', verified: true, question: R`\(no2\)`, options: {} },
            { _id: 'w4', verified: true, rpta: 'A', origin: 'Docente', question: R`\(no3\)`, options: {} },
            // Una formula invalida.
            { _id: 'w5', verified: true, rpta: 'A', question: R`<p>\(\frac{\)</p>`, options: {} },
        ]);
        await db.collection('blocks').insertOne({ _id: 'bl1', text: R`<p>\(e\)</p>` });
        await db.collection('exams').insertMany([
            {
                _id: 'ex1', verified: true,
                general_items: [{ id: 'g', question: R`\(f\)`, options: { A: R`\(a\)` }, resolution: R`<p>\[g\]</p>` }],
                areas: { A: { items: [{ id: 'h', question: R`\(h\)`, options: [{ opt: 'A', option: R`\(i\)` }] }] } },
            },
            { _id: 'ex2', verified: false, general_items: [{ id: 'z', question: R`\(no4\)` }] },
        ]);
        // Simulacro de prospecto: el snapshot solo guarda referencias; la formula `p1` vive en una
        // pregunta NO practicable (verified:false) y solo la alcanza lo que el intento sirve.
        await db.collection('prospects').insertOne({ _id: 'prw', exam_unique: false });
        await db.collection('questions').insertOne({ _id: 'wp1', verified: false, rpta: 'A', question: R`<p>\(p1\)</p>`, options: { A: R`\(p2\)` } });
        await db.collection('simulacrums').insertMany([
            { _id: 'si3', slug: 'sim-prospecto', verified: true, state: true, general: false, prospect: 'prw', areas: { A: { questions: [{ itype: 'question', id: 'wp1' }] } } },
            { _id: 'si1', verified: true, state: true, general_items: [{ id: 's', question: R`\(j\)` }], areas: { I: { questions: [{ id: 't', question: R`\(k\)`, resolution: R`\(a\)` }] } } },
            { _id: 'si2', verified: true, state: false, general_items: [{ id: 'u', question: R`\(no5\)` }] },
        ]);
    });

    after(async () => {
        await ctx.stop();
        await fs.rm(storageDir, { recursive: true, force: true });
    });

    it('collectFormulas recorre las cuatro fuentes y cuenta solo lo que la API sirve', async () => {
        const scan = await catalog.collectFormulas();
        const tex = [...scan.formulas.values()].map((f) => f.tex).sort();
        // a (repetida en varias fuentes), b..k y la invalida; ninguna "no1".."no5".
        assert.deepEqual(tex, ['\\frac{', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'p1', 'p2']);
        assert.equal(scan.documents, 6, 'w1, w5, bl1, ex1, si1 y si3');
        const a = [...scan.formulas.values()].find((f) => f.tex === 'a' && f.mode === 'inline');
        assert.ok(a.refs >= 4, 'a aparece en varias fuentes y se cuenta una sola vez');
    });

    it('simulacros de prospecto: las formulas salen de lo que sirve el intento, no del snapshot', async () => {
        const scan = await catalog.collectFormulas({ sources: ['simulacra'], slug: 'sim-prospecto' });
        assert.equal(scan.documents, 1);
        assert.deepEqual([...scan.formulas.values()].map((f) => f.tex).sort(), ['p1', 'p2']);
    });

    it('--source y limit acotan la lectura', async () => {
        const only = await catalog.collectFormulas({ sources: ['blocks'] });
        assert.deepEqual([...only.formulas.values()].map((f) => f.tex), ['e']);
        const limited = await catalog.collectFormulas({ sources: ['questions'], limit: 1 });
        assert.equal(limited.documents, 1);
    });

    it('warmFormulas convierte, reporta la fallida con su origen y es idempotente', async () => {
        const { formulas } = await catalog.collectFormulas();
        const store = storeModule.createMathStore();
        try {
            const first = await catalog.warmFormulas(formulas, store);
            assert.equal(first.failed.length, 1);
            assert.equal(first.failed[0].tex, '\\frac{');
            assert.equal(first.failed[0].first, 'questions:w5');
            assert.equal(first.converted, formulas.size - 1);
            assert.equal(store.stats.generated, formulas.size - 1);

            const stats = await admin.directoryStats(store.dir);
            assert.equal(stats.svgs, formulas.size - 1);
            assert.ok(stats.bytes > 0);

            const again = storeModule.createMathStore();
            const second = await catalog.warmFormulas(formulas, again);
            assert.equal(again.stats.generated, 0, 'la segunda pasada no vuelve a convertir');
            assert.equal(second.converted, formulas.size - 1);
            again.close();
        } finally {
            store.close();
        }
    });

    it('pruneCache: informa sin --apply, borra con --apply y respeta lo vigente, lo reciente y lo ajeno', async () => {
        const { formulas } = await catalog.collectFormulas();
        const live = catalog.liveHashes(formulas, storeModule.MATH_VERSION);
        const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
        const hex = (c) => c.repeat(32);

        // Huerfanos viejos (otra version / formula retirada), uno reciente, un temporal viejo y un archivo ajeno.
        for (const name of [`${hex('a')}.svg`, `${hex('a')}.json`, `${hex('b')}.svg`, `${hex('c')}.svg.abc123.tmp`]) {
            await fs.writeFile(path.join(mathDir, name), 'x');
            await fs.utimes(path.join(mathDir, name), old, old);
        }
        await fs.writeFile(path.join(mathDir, `${hex('d')}.svg`), 'x'); // recien creado
        await fs.writeFile(path.join(mathDir, 'notas.txt'), 'no tocar');
        await fs.utimes(path.join(mathDir, 'notas.txt'), old, old);

        const before = (await fs.readdir(mathDir)).length;
        const dry = await admin.pruneCache({ dir: mathDir, live });
        assert.deepEqual(dry.removed.sort(), [`${hex('a')}.json`, `${hex('a')}.svg`, `${hex('b')}.svg`, `${hex('c')}.svg.abc123.tmp`].sort());
        assert.equal(dry.skippedRecent, 1);
        assert.equal(dry.kept, (formulas.size - 1) * 2);
        assert.equal((await fs.readdir(mathDir)).length, before, 'sin apply no se borra nada');

        const applied = await admin.pruneCache({ dir: mathDir, live, apply: true });
        assert.equal(applied.removed.length, 4);
        const left = await fs.readdir(mathDir);
        assert.ok(left.includes('notas.txt') && left.includes(`${hex('d')}.svg`));
        assert.ok(!left.includes(`${hex('a')}.svg`));
        assert.equal(left.length, before - 4);
    });

    it('pruneCache sobre una carpeta que no existe no falla', async () => {
        const result = await admin.pruneCache({ dir: path.join(storageDir, 'no-existe'), live: new Set() });
        assert.deepEqual(result, { removed: [], kept: 0, bytes: 0, skippedRecent: 0 });
    });

    describe('scripts', () => {
        const script = (name, ...args) => run(process.execPath, [path.resolve('scripts', name), ...args], {
            env: { ...process.env, MONGODB_URI: process.env.MONGODB_URI, STORAGE_DIR: storageDir },
            timeout: 120_000,
        });

        it('warm_math_cache --dry-run cuenta y no escribe', async () => {
            const before = (await fs.readdir(mathDir)).length;
            const { stdout } = await script('warm_math_cache.js', '--dry-run');
            assert.match(stdout, /14 distintas/);
            assert.match(stdout, /--dry-run: no se convirtio/);
            assert.equal((await fs.readdir(mathDir)).length, before);
        });

        it('warm_math_cache convierte lo que falta, guarda el CSV de fallidas y --strict sale con 1', async () => {
            const csv = path.join(storageDir, 'fallidas.csv');
            await assert.rejects(script('warm_math_cache.js', `--failures=${csv}`, '--strict'), (error) => error.code === 1);
            const text = await fs.readFile(csv, 'utf8');
            assert.match(text, /origen,modo,error,tex/);
            assert.match(text, /questions:w5/);
        });

        it('warm_math_cache sin --strict termina bien aunque haya fallidas', async () => {
            const { stdout } = await script('warm_math_cache.js', '--source=questions', '--limit=10');
            assert.match(stdout, /fallidas: 1/);
        });

        it('prune_math_cache informa por defecto y borra con --apply', async () => {
            const orphan = path.join(mathDir, `${'e'.repeat(32)}.svg`);
            await fs.writeFile(orphan, 'x');
            const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
            await fs.utimes(orphan, old, old);

            const dry = await script('prune_math_cache.js');
            assert.match(dry.stdout, /A borrar: 1 archivos/);
            await fs.access(orphan);

            const applied = await script('prune_math_cache.js', '--apply');
            assert.match(applied.stdout, /Borrados: 1 archivos/);
            await assert.rejects(fs.access(orphan));
        });

        it('los scripts rechazan argumentos desconocidos', async () => {
            await assert.rejects(script('warm_math_cache.js', '--source=otra'), (error) => error.code !== 0);
            await assert.rejects(script('prune_math_cache.js', '--borrar'), (error) => error.code !== 0);
        });
    });
});
