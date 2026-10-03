/**
 * Plan del auto-ensamblado de simulacros para UN curso.
 *
 * Modulo hoja y sin acceso a la base de datos: recibe lo que hay disponible en
 * el banco y la configuracion del modal, y decide que lecturas y preguntas
 * entran y que condiciones se cumplen. La consulta y el guardado viven en
 * #Services/simulacrum_assembler.service.js.
 *
 * Reglas:
 * - Las lecturas entran con TODAS sus preguntas validas, que cuentan para el
 *   total del curso.
 * - Si se definen temas, sus cantidades deben sumar exactamente lo que queda
 *   tras las lecturas. Sin temas, el resto se completa al azar.
 */

export const shuffle = (list, random = Math.random) => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
};

const toCount = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Junta temas repetidos y descarta los vacios o con cantidad 0. */
export const normalizeTopics = (topics = []) => {
    const merged = new Map();
    for (const item of Array.isArray(topics) ? topics : []) {
        const topic = String(item?.topic ?? '').trim();
        const count = toCount(item?.count);
        if (!topic || count === 0) continue;
        merged.set(topic, (merged.get(topic) ?? 0) + count);
    }
    return [...merged].map(([topic, count]) => ({ topic, count }));
};

/**
 * @param {object} input
 * @param {number} input.required              preguntas que pide el curso
 * @param {Array<{id: string, questionIds: string[]}>} input.blocks  lecturas con sus preguntas validas
 * @param {Array<{id: string, topic?: string}>} input.loose  preguntas sueltas validas
 * @param {{blocks?: number, topics?: Array<{topic: string, count: number}>}} input.config
 * @param {() => number} [input.random]
 */
export const planSubject = ({ required, blocks = [], loose = [], config = {}, random = Math.random }) => {
    const checks = [];
    const wantedBlocks = toCount(config.blocks);
    const topics = normalizeTopics(config.topics);

    // 1. Lecturas: al azar, sin pasarse del total del curso.
    const chosenBlocks = [];
    let fromBlocks = 0;
    if (wantedBlocks > 0) {
        for (const block of shuffle(blocks.filter((b) => b.questionIds.length > 0), random)) {
            if (chosenBlocks.length >= wantedBlocks) break;
            if (fromBlocks + block.questionIds.length > required) continue;
            chosenBlocks.push(block);
            fromBlocks += block.questionIds.length;
        }
        checks.push({
            type: 'blocks',
            ok: chosenBlocks.length === wantedBlocks,
            label: 'Lecturas',
            required: wantedBlocks,
            value: chosenBlocks.length,
            message: chosenBlocks.length === wantedBlocks
                ? `${wantedBlocks} lectura(s) con ${fromBlocks} pregunta(s)`
                : `Se pidieron ${wantedBlocks} lectura(s), solo caben ${chosenBlocks.length} (hay ${blocks.length} disponibles)`,
        });
    }

    const used = new Set(chosenBlocks.flatMap((b) => b.questionIds));
    const pool = loose.filter((q) => !used.has(q.id));
    const remaining = Math.max(required - fromBlocks, 0);
    const picked = [];

    // 2. Preguntas sueltas: por tema (suma exacta) o al azar.
    if (topics.length > 0) {
        const sum = topics.reduce((acc, t) => acc + t.count, 0);
        checks.push({
            type: 'topics_sum',
            ok: sum === remaining,
            label: 'Suma de temas',
            required: remaining,
            value: sum,
            message: sum === remaining
                ? `Los temas suman ${sum}`
                : `Los temas suman ${sum}, se necesitan ${remaining}` + (fromBlocks > 0 ? ` (${required} − ${fromBlocks} de lecturas)` : ''),
        });

        for (const { topic, count } of topics) {
            const available = pool.filter((q) => q.topic === topic);
            // Aun forzando, nunca se pasa del total del curso.
            const take = Math.min(count, available.length, remaining - picked.length);
            picked.push(...shuffle(available, random).slice(0, Math.max(take, 0)));
            checks.push({
                type: 'topic',
                ok: available.length >= count,
                label: `Tema: ${topic}`,
                required: count,
                value: available.length,
                message: available.length >= count
                    ? `${count} de ${available.length} disponibles`
                    : `Se piden ${count}, solo hay ${available.length} disponibles`,
            });
        }
    } else {
        picked.push(...shuffle(pool, random).slice(0, remaining));
    }

    const total = fromBlocks + picked.length;
    checks.push({
        type: 'total',
        ok: total === required,
        label: 'Total',
        required,
        value: total,
        message: total === required
            ? `${total} de ${required} preguntas`
            : `Solo se alcanzan ${total} de ${required} preguntas`,
    });

    return {
        required,
        assigned: total,
        valid: checks.every((c) => c.ok),
        checks,
        selection: {
            blocks: chosenBlocks.map((b) => ({ id: b.id, questionIds: [...b.questionIds] })),
            questionIds: picked.map((q) => q.id),
        },
    };
};

/**
 * Agrupa los items de un simulacro para ordenarlos sin separar una lectura de
 * sus preguntas: dentro de cada curso van primero las sueltas (por tema) y
 * despues cada lectura seguida de sus preguntas.
 *
 * @param {Array} items    items ya enriquecidos con `area` y `topic`
 * @param {Map<string, string[]>} blockQuestions  id de lectura -> ids de sus preguntas
 * @param {string[]} subjects  orden de los cursos
 */
export const orderItemsKeepingBlocks = (items, blockQuestions, subjects = []) => {
    const idOf = (item) => String(item.id ?? item._id);
    const present = new Set(items.map(idOf));

    // Pregunta -> lectura, solo para lecturas que estan en el simulacro.
    const owner = new Map();
    for (const item of items) {
        if (item.itype !== 'block') continue;
        for (const qid of blockQuestions.get(idOf(item)) ?? []) {
            if (present.has(String(qid)) && !owner.has(String(qid))) owner.set(String(qid), idOf(item));
        }
    }

    const units = [];
    const groups = new Map();
    for (const item of items) {
        if (item.itype === 'block') {
            const unit = { group: true, area: item.area, topic: null, items: [item] };
            groups.set(idOf(item), unit);
            units.push(unit);
        }
    }
    for (const item of items) {
        if (item.itype === 'block') continue;
        const group = groups.get(owner.get(idOf(item)));
        if (group) {
            group.items.push(item);
            group.area = group.area || item.area;
            group.topic = group.topic ?? item.topic ?? null;
        } else {
            units.push({ group: false, area: item.area, topic: item.topic, items: [item] });
        }
    }

    const position = (area) => {
        const index = subjects.indexOf(area);
        return index === -1 ? 999 : index;
    };
    units.sort((a, b) => {
        const byArea = position(a.area) - position(b.area);
        if (byArea !== 0) return byArea;
        if (a.group !== b.group) return a.group ? 1 : -1;
        return (a.topic || '').toLowerCase().localeCompare((b.topic || '').toLowerCase());
    });

    return units.flatMap((unit) => unit.items);
};
