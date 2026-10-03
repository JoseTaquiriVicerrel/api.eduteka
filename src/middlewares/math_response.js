import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { mathStore } from '#Libs/math_store.js';
import { replaceMath } from '#Libs/math_svg.js';

// Con `?math=svg` sustituye las formulas LaTeX del HTML de la respuesta por <img> que
// apuntan a SVG (docs/api-latex-svg-plan.md §3.4). Sin el parametro no hace nada y la
// respuesta es la de siempre.
//
// Va montado ANTES de las validaciones de cada modulo: los esquemas de query son estrictos
// (`additionalProperties: false`), asi que el parametro se lee y se quita aqui.
//
// Solo se transforman las claves HTML conocidas (lista blanca): cualquier otro texto de la
// respuesta (nombres, titulos, errores) queda intacto aunque lleve `\(`.

/** Claves del JSON de salida cuyo valor es HTML con posible LaTeX. */
export const MATH_KEYS = new Set(['question', 'text', 'explanation']);

const isPlain = (value) => {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};

/**
 * Copia de `body` con las formulas de las claves HTML ya sustituidas. No muta el original
 * (puede venir de una cache) y deja tal cual lo que no es un objeto o arreglo plano.
 */
export const transformPayload = async (body, convert, { baseUrl = '', failed = [] } = {}) => {
    const walk = async (node, ownerId) => {
        if (Array.isArray(node)) return Promise.all(node.map((item) => walk(item, ownerId)));
        if (!isPlain(node)) return node;

        const id = node.id ?? node.question_id ?? ownerId;
        const entries = await Promise.all(Object.entries(node).map(async ([key, value]) => {
            if (typeof value === 'string') {
                if (!MATH_KEYS.has(key)) return [key, value];
                const result = await replaceMath(value, convert, { baseUrl });
                for (const item of result.failed) failed.push({ question_id: id ?? null, ...item });
                return [key, result.html];
            }
            return [key, await walk(value, id)];
        }));
        return Object.fromEntries(entries);
    };
    return walk(body, undefined);
};

/**
 * @param {{ store?: ReturnType<typeof mathStore>, budgetMs?: number }} [options]
 *   `budgetMs`: tiempo maximo que una respuesta dedica a convertir formulas nuevas. Pasado ese
 *   plazo las que falten se dejan en LaTeX (las ya convertidas se siguen sirviendo de la cache,
 *   y las nuevas se completan en las siguientes peticiones).
 */
export const createMathResponse = ({ store, budgetMs = 5000 } = {}) => (req, res, next) => {
    if (!('math' in req.query)) return next();

    const requested = req.query.math;
    delete req.query.math;
    if (requested !== 'svg') {
        return next(ApiError.validation([{ field: 'math', message: 'Debe ser svg.' }]));
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode >= 400) return originalJson(body);

        const deadline = Date.now() + budgetMs;
        const failed = [];
        const convert = async (input) => {
            if (Date.now() > deadline) throw new Error('presupuesto de tiempo agotado');
            return (store ?? mathStore()).getAsset(input);
        };

        transformPayload(body, convert, { baseUrl: settings.app.apiUrl ?? '', failed })
            .then((transformed) => {
                if (failed.length > 0) {
                    req.log?.warn({ math_failed: failed.slice(0, 20), math_failed_total: failed.length }, 'formulas LaTeX sin convertir; se dejan en LaTeX');
                }
                originalJson(transformed);
            })
            .catch((error) => {
                // Nunca se rompe la respuesta por culpa de las formulas.
                req.log?.error({ err: error }, 'fallo al convertir formulas; se responde sin convertir');
                originalJson(body);
            });
        return res;
    };
    return next();
};

export default createMathResponse();
