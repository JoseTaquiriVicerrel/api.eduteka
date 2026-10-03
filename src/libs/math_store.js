import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { settings } from '#Config/settings.js';
import { logger } from '#Libs/logger.js';
import { MATH_TEMPLATE_VERSION, mathHash, texForMode } from '#Libs/math_svg.js';

// Generacion y cache de los SVG de formulas (docs/api-latex-svg-plan.md §3.1 y §3.2).
//
//   getAsset({ tex, mode }) -> { hash, w, h, valign }
//
// El SVG se guarda en STORAGE_DIR/math/<hash>.svg y sus medidas en <hash>.json. Un LRU en
// memoria guarda las medidas: cada <img> las necesita en cada peticion y no queremos una
// lectura de disco por formula.

const require = createRequire(import.meta.url);
/** Versiones que invalidan toda la cache al cambiar: MathJax + la plantilla propia. */
export const MATH_VERSION = `mj${require('mathjax-full/package.json').version}-t${MATH_TEMPLATE_VERSION}`;

const WORKER_URL = new URL('./math_worker.js', import.meta.url);
const HASH_FILE = /^[a-f0-9]{32}\.svg$/;

/** Ruta en disco de un SVG de formula, o null si el nombre no es valido (evita path traversal). */
export const mathFilePath = (file, dir = path.join(settings.storageDir, 'math')) => (HASH_FILE.test(file) ? path.join(dir, file) : null);

/**
 * Un worker con MathJax. Las peticiones se atienden de una en una; si una supera el
 * timeout el worker se termina (un TeX patologico no puede bloquear el servidor) y se
 * crea otro en la siguiente peticion.
 */
export const createMathRenderer = ({ timeoutMs = 2000, startupMs = 20000, workerUrl = WORKER_URL } = {}) => {
    let worker = null;
    let ready = false;
    let startupTimer = null;
    let current = null;
    const queue = [];
    let nextId = 1;

    const stop = () => {
        const old = worker;
        worker = null;
        ready = false;
        clearTimeout(startupTimer);
        old?.removeAllListeners();
        old?.terminate().catch(() => {});
    };

    const settle = (outcome, value) => {
        if (!current) return;
        clearTimeout(current.timer);
        const { resolve, reject } = current;
        current = null;
        if (outcome === 'ok') resolve(value);
        else reject(value);
        pump();
    };

    // El plazo por formula cuenta desde que el worker recibe el trabajo, NO desde que arranca:
    // cargar MathJax tarda ~1 s (mas con la maquina cargada) y no es culpa de la formula.
    const dispatch = () => {
        if (!current || !ready || current.sent) return;
        current.sent = true;
        current.timer = setTimeout(() => {
            stop();
            settle('error', new Error(`timeout de ${timeoutMs} ms al convertir la formula`));
        }, timeoutMs);
        worker.postMessage({ id: current.id, tex: current.tex, display: current.display });
    };

    const ensureWorker = () => {
        if (worker) return;
        worker = new Worker(workerUrl);
        worker.unref();
        // Si el worker no llega a avisar que esta listo, no se queda esperando para siempre.
        startupTimer = setTimeout(() => {
            stop();
            settle('error', new Error(`el worker de MathJax no arranco en ${startupMs} ms`));
        }, startupMs);
        startupTimer.unref?.();
        worker.on('message', (message) => {
            if (message.ready) {
                ready = true;
                clearTimeout(startupTimer);
                dispatch();
                return;
            }
            if (!current || message.id !== current.id) return;
            if (message.error) settle('error', new Error(message.error));
            else settle('ok', { svg: message.svg, w: message.w, h: message.h, valign: message.valign });
        });
        worker.on('error', (error) => { stop(); settle('error', error); });
        worker.on('exit', () => { stop(); settle('error', new Error('el worker de MathJax se cerro')); });
    };

    function pump() {
        if (current || queue.length === 0) return;
        current = { ...queue.shift(), id: nextId, sent: false };
        nextId += 1;
        ensureWorker();
        dispatch();
    }

    return {
        render: ({ tex, display }) => new Promise((resolve, reject) => {
            queue.push({ tex, display, resolve, reject });
            pump();
        }),
        close: () => {
            stop();
            for (const job of queue.splice(0)) job.reject(new Error('renderizador cerrado'));
            if (current) settle('error', new Error('renderizador cerrado'));
        },
    };
};

const writeAtomic = async (target, content) => {
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.writeFile(tmp, content);
        await fs.rename(tmp, target);
    } catch (error) {
        await fs.unlink(tmp).catch(() => {});
        throw error;
    }
};

class Lru {
    constructor(max) { this.max = max; this.map = new Map(); }

    get(key) {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    set(key, value) {
        this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }

    get size() { return this.map.size; }
}

/**
 * Almacen de SVG de formulas. `renderer` y `dir` se inyectan para las pruebas.
 * Un fallo de conversion NO se guarda: se reintentaria en la siguiente peticion.
 */
export const createMathStore = ({
    dir = path.join(settings.storageDir, 'math'),
    version = MATH_VERSION,
    renderer = createMathRenderer(),
    lruSize = 20000,
} = {}) => {
    const lru = new Lru(lruSize);
    const inflight = new Map();
    const stats = { memoryHits: 0, diskHits: 0, generated: 0, failed: 0 };

    const resolveAsset = async (hash, tex, mode) => {
        const svgFile = path.join(dir, `${hash}.svg`);
        const metaFile = path.join(dir, `${hash}.json`);

        try {
            const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
            await fs.access(svgFile);
            stats.diskHits += 1;
            return { hash, ...meta };
        } catch { /* no esta en disco: se genera */ }

        const { svg, w, h, valign } = await renderer.render({ tex: texForMode(tex, mode), display: mode === 'block' });
        await fs.mkdir(dir, { recursive: true });
        // Primero el SVG y despues el JSON: el JSON es la marca de "completo".
        await writeAtomic(svgFile, svg);
        await writeAtomic(metaFile, JSON.stringify({ w, h, valign }));
        stats.generated += 1;
        return { hash, w, h, valign };
    };

    return {
        stats,
        dir,
        version,
        /** @returns {Promise<{ hash: string, w: string, h: string, valign: string }>} lanza si la formula no se pudo convertir */
        getAsset: async ({ tex, mode }) => {
            const hash = mathHash({ tex, mode, version });
            const cached = lru.get(hash);
            if (cached) { stats.memoryHits += 1; return cached; }

            if (!inflight.has(hash)) {
                const job = resolveAsset(hash, tex, mode)
                    .then((asset) => { lru.set(hash, asset); return asset; })
                    .catch((error) => {
                        stats.failed += 1;
                        logger.warn(`[math] no se pudo convertir una formula: ${error.message}`);
                        throw error;
                    })
                    .finally(() => inflight.delete(hash));
                inflight.set(hash, job);
            }
            return inflight.get(hash);
        },
        lruSize: () => lru.size,
        close: () => renderer.close(),
    };
};

let defaultStore;
/** Almacen compartido del proceso (se crea en el primer uso). */
export const mathStore = () => {
    defaultStore ??= createMathStore();
    return defaultStore;
};
