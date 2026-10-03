import { collectFormulas, liveHashes } from '#Libs/math_catalog.js';
import { formatBytes, pruneCache } from '#Libs/math_cache_admin.js';
import { MATH_VERSION, createMathStore } from '#Libs/math_store.js';
import { connect, disconnect, endProgress, parseArgs, progress } from './_math_cli.js';

// Borra de STORAGE_DIR/math los SVG que ya no corresponden: de una version anterior de MathJax
// o de la plantilla (MATH_VERSION), o de formulas que ya no estan en el banco. Siempre recorre
// TODAS las fuentes: con un subconjunto borraria SVG vigentes.
//
//   node scripts/prune_math_cache.js              solo informa (no borra)
//   node scripts/prune_math_cache.js --apply      borra
//        [--min-age-minutes=60]  no toca archivos mas jovenes (podrian estar escribiendose)
//        [--force]               permite continuar si el banco no devuelve ninguna formula

const args = parseArgs(process.argv.slice(2), ['apply', 'min-age-minutes', 'force']);
const minAgeMinutes = args['min-age-minutes'] === undefined ? 60 : Number.parseFloat(args['min-age-minutes']);
if (!(minAgeMinutes >= 0)) throw new Error('--min-age-minutes debe ser un numero >= 0');

await connect();
let exitCode = 0;
// Solo para saber la carpeta y la version; no se convierte nada.
const store = createMathStore();

try {
    console.log(`Version vigente: ${MATH_VERSION}`);
    console.log(`Carpeta: ${store.dir}`);

    const scan = await collectFormulas({ onDocument: (source, n) => n % 200 === 0 && progress(`Leyendo ${source}... ${n} documentos`) });
    endProgress();
    console.log(`Formulas vigentes en el banco: ${scan.formulas.size} (${scan.documents} documentos)`);

    // Un banco vacio casi siempre es una conexion equivocada: borrar con eso vaciaria la cache.
    if (scan.formulas.size === 0 && !args.force) {
        throw new Error('El banco no devolvio ninguna formula; se aborta para no vaciar la cache. Use --force si es correcto.');
    }

    const result = await pruneCache({
        dir: store.dir,
        live: liveHashes(scan.formulas, MATH_VERSION),
        apply: Boolean(args.apply),
        minAgeMs: minAgeMinutes * 60 * 1000,
    });

    console.log(`Se conservan ${result.kept} archivos vigentes.`);
    console.log(`${args.apply ? 'Borrados' : 'A borrar'}: ${result.removed.length} archivos (${formatBytes(result.bytes)}). Omitidos por recientes: ${result.skippedRecent}.`);
    if (!args.apply && result.removed.length) console.log('\nNo se borro nada. Repita con --apply para borrar.');
} catch (error) {
    console.error('\nError:', error.message);
    exitCode = 1;
} finally {
    store.close();
    await disconnect();
}
process.exit(exitCode);
