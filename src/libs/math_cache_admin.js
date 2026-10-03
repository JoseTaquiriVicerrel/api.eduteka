import fs from 'node:fs/promises';
import path from 'node:path';

// Mantenimiento de STORAGE_DIR/math: tamaño y limpieza (scripts/prune_math_cache.js).

const CACHE_FILE = /^([a-f0-9]{32})\.(svg|json)$/;
const TEMP_FILE = /^[a-f0-9]{32}\.(?:svg|json)\.[a-f0-9]+\.tmp$/;

const listFiles = async (dir) => {
    try {
        return await fs.readdir(dir);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
};

/** Cuantos SVG hay y cuanto ocupa la carpeta (svg + json). */
export const directoryStats = async (dir) => {
    let svgs = 0;
    let bytes = 0;
    for (const name of await listFiles(dir)) {
        if (!CACHE_FILE.test(name) && !TEMP_FILE.test(name)) continue;
        if (name.endsWith('.svg')) svgs += 1;
        bytes += (await fs.stat(path.join(dir, name))).size;
    }
    return { svgs, bytes };
};

/** De los hashes dados, cuantos ya tienen su SVG y sus medidas en disco. */
export const countCached = async (dir, hashes) => {
    const present = new Set(await listFiles(dir));
    let cached = 0;
    for (const hash of hashes) if (present.has(`${hash}.svg`) && present.has(`${hash}.json`)) cached += 1;
    return cached;
};

/**
 * Borra los archivos de la cache cuyo hash no esta en `live` (otra version de MathJax o de la
 * plantilla, o una formula que ya no esta en el banco) y los temporales abandonados. No toca
 * nada mas joven que `minAgeMs` (podria estar escribiendose ahora) ni archivos ajenos a la cache.
 * Sin `apply` solo informa.
 * @returns {Promise<{ removed: string[], kept: number, bytes: number, skippedRecent: number }>}
 */
export const pruneCache = async ({ dir, live, apply = false, minAgeMs = 60 * 60 * 1000, now = Date.now() }) => {
    const removed = [];
    let kept = 0;
    let bytes = 0;
    let skippedRecent = 0;

    for (const name of await listFiles(dir)) {
        const match = CACHE_FILE.exec(name);
        const isTemp = TEMP_FILE.test(name);
        if (!match && !isTemp) continue; // no es de la cache: no se toca
        if (match && live.has(match[1])) { kept += 1; continue; }

        const file = path.join(dir, name);
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs < minAgeMs) { skippedRecent += 1; continue; }

        bytes += stat.size;
        removed.push(name);
        if (apply) await fs.unlink(file);
    }
    return { removed, kept, bytes, skippedRecent };
};

export const formatBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
