// Precalienta las formulas de un examen o simulacro cuando el monolito avisa que cambio
// (docs/spec-formulas-svg-al-publicar.md §3.2). Cola de 1 trabajo a la vez, deduplicada por `kind:id`,
// que comparte el renderer (worker) de MathJax con las peticiones: no bloquea el event loop.

import { collectFormulas, warmFormulas } from '#Libs/math_catalog.js';
import { mathStore } from '#Libs/math_store.js';
import { subscribeContent } from '#Libs/content_events.js';
import { logger } from '#Libs/logger.js';

const pending = new Map();
let draining = null;

const scanFor = ({ kind, id }) => (kind === 'exam'
    ? collectFormulas({ sources: ['exams'], exam: id })
    : collectFormulas({ sources: ['simulacra'], simulacrum: id }));

/** Convierte las formulas del documento. Nunca lanza. Devuelve el resumen o null si no hubo nada que hacer. */
export const prewarmContent = async (signal, store = mathStore()) => {
    const label = `${signal.kind}:${signal.id}`;
    try {
        const scan = await scanFor(signal);
        if (!scan.documents) {
            logger.info({ doc: label }, '[math] precalentamiento omitido: el contenido no esta verificado/publicado');
            return null;
        }
        const before = store.stats.generated;
        const report = await warmFormulas(scan.formulas, store);
        const summary = {
            doc: label, formulas: scan.formulas.size, converted: report.converted,
            generated: store.stats.generated - before, failed: report.failed.length, ms: report.ms,
        };
        logger.info(summary, '[math] precalentamiento terminado');
        for (const item of report.failed) {
            logger.warn({ doc: label, source: item.first, tex: item.tex.slice(0, 80), error: item.error }, '[math] formula sin convertir');
        }
        return summary;
    } catch (error) {
        logger.error({ doc: label, err: error?.message }, '[math] precalentamiento fallido');
        return null;
    }
};

const drain = async () => {
    while (pending.size) {
        const [key, signal] = pending.entries().next().value;
        pending.delete(key); // una senal nueva durante el trabajo vuelve a encolarlo
        await prewarmContent(signal);
    }
    draining = null;
};

/** Encola (deduplicado por kind:id). La promesa se cumple cuando la cola queda vacia. */
export const enqueuePrewarm = (signal) => {
    pending.set(`${signal.kind}:${signal.id}`, signal);
    draining ??= drain();
    return draining;
};

/** Se suscribe a las senales de contenido. Devuelve la funcion para cancelar. */
export const startMathPrewarm = () => subscribeContent((signal) => enqueuePrewarm(signal));
