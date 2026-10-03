import fs from 'node:fs/promises';
import path from 'node:path';
import { collectFormulas, warmFormulas } from '#Libs/math_catalog.js';
import { countCached, directoryStats, formatBytes } from '#Libs/math_cache_admin.js';
import { MATH_VERSION, createMathStore } from '#Libs/math_store.js';
import { mathHash } from '#Libs/math_svg.js';
import { connect, disconnect, endProgress, parseArgs, parseSources, progress } from './_math_cli.js';

// Precalienta la cache de SVG de formulas: recorre el banco, convierte cada formula distinta
// y deja el resultado en STORAGE_DIR/math. Es idempotente: se puede relanzar y solo convierte
// lo que falta. Lista las formulas que MathJax no pudo convertir (tambien se verian mal en la web).
//
//   node scripts/warm_math_cache.js [--source=questions,blocks,exams,simulacra]
//        [--limit=N]            documentos por fuente (para probar)
//        [--dry-run]            solo cuenta, no convierte ni escribe
//        [--failures=ruta.csv]  guarda todas las fallidas en un CSV
//        [--strict]             codigo de salida 1 si alguna fallo

const args = parseArgs(process.argv.slice(2), ['source', 'limit', 'dry-run', 'failures', 'strict']);
const sources = parseSources(args.source);
const limit = args.limit ? Number.parseInt(args.limit, 10) : 0;
if (args.limit && !(limit > 0)) throw new Error('--limit debe ser un entero positivo');

const csvCell = (value) => `"${String(value).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

await connect();
const store = createMathStore();
let exitCode = 0;

try {
    console.log(`Version de la cache: ${MATH_VERSION}`);
    console.log(`Carpeta: ${store.dir}`);
    console.log(`Fuentes: ${sources.join(', ')}${limit ? ` (maximo ${limit} documentos por fuente)` : ''}`);

    const scanStart = Date.now();
    const scan = await collectFormulas({ sources, limit, onDocument: (source, n) => n % 200 === 0 && progress(`Leyendo ${source}... ${n} documentos`) });
    endProgress();
    const { formulas } = scan;
    console.log(`\nDocumentos: ${scan.documents} | fragmentos HTML: ${scan.fragments} | formulas: ${scan.occurrences} (${formulas.size} distintas) | ${((Date.now() - scanStart) / 1000).toFixed(1)} s`);

    const hashes = [...formulas.values()].map(({ tex, mode }) => mathHash({ tex, mode, version: MATH_VERSION }));
    const cached = await countCached(store.dir, hashes);
    console.log(`Ya en cache: ${cached} | por convertir: ${formulas.size - cached}`);

    if (args['dry-run']) {
        console.log('\n--dry-run: no se convirtio ni se escribio nada.');
    } else {
        const report = await warmFormulas(formulas, store, { onProgress: (done, total) => done % 25 === 0 && progress(`Convirtiendo ${done}/${total}`) });
        endProgress();
        const stats = await directoryStats(store.dir);
        const generated = store.stats.generated;

        console.log(`\nConvertidas (nuevas + ya en cache): ${report.converted} | nuevas: ${generated} | fallidas: ${report.failed.length}`);
        console.log(`Tiempo: ${(report.ms / 1000).toFixed(1)} s${generated ? ` (${(report.ms / generated).toFixed(1)} ms por formula nueva)` : ''}`);
        console.log(`En disco: ${stats.svgs} SVG, ${formatBytes(stats.bytes)} en total${stats.svgs ? ` (${formatBytes(stats.bytes / stats.svgs)} de media)` : ''}`);

        if (report.failed.length) {
            console.log('\nFormulas que no se pudieron convertir (primeras 20):');
            for (const item of report.failed.slice(0, 20)) console.log(`  [${item.first}] ${item.tex.slice(0, 70)}  ->  ${item.error}`);
            if (args.failures && args.failures !== true) {
                const rows = ['origen,modo,error,tex', ...report.failed.map((item) => [item.first, item.mode, item.error, item.tex].map(csvCell).join(','))];
                await fs.writeFile(path.resolve(args.failures), `﻿${rows.join('\n')}\n`);
                console.log(`\nTodas las fallidas (${report.failed.length}) guardadas en ${path.resolve(args.failures)}`);
            }
            if (args.strict) exitCode = 1;
        }
    }
} catch (error) {
    console.error('\nError:', error.message);
    exitCode = 1;
} finally {
    store.close();
    await disconnect();
}
process.exit(exitCode);
