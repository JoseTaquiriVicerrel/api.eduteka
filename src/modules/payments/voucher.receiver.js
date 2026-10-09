// Quien recibio el pago segun el comprobante. La IA lee el nombre que muestra Yape/Plin
// ("receptor"), que suele venir abreviado ("Jose T. Taquiri V."), en otro orden o con otras
// tildes que el titular configurado. Aqui se decide, sin lanzar nunca, si ese nombre (o los
// digitos del numero, a veces enmascarado: "*** *** 077") corresponde a alguno de los
// metodos de pago de la API. Una duda no rechaza el pago: lo manda a revision manual.

const tokensOf = (text) => String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const digitsOf = (text) => String(text ?? '').replace(/\D/g, '');

// Una palabra de `a` casa con una de `b` si es igual o si es una inicial/abreviatura de ella
// ("t" o "taq" casan con "taquiri"). Cada palabra de `b` se usa una sola vez. Exige al menos
// una coincidencia exacta de 3+ letras, para que solo las iniciales ("J. T.") no basten.
const covers = (a, b) => {
    const free = [...b];
    let exact = 0;
    for (const word of a) {
        const index = free.findIndex((candidate) => candidate === word || candidate.startsWith(word));
        if (index === -1) return false;
        if (free[index] === word && word.length >= 3) exact += 1;
        free.splice(index, 1);
    }
    return exact > 0;
};

/** El nombre leido en el comprobante corresponde al titular (en cualquier orden y abreviado). */
export const nameMatches = (receptor, holder) => {
    const read = tokensOf(receptor);
    const expected = tokensOf(holder);
    if (read.length === 0 || expected.length === 0) return false;
    return covers(read, expected) || covers(expected, read);
};

/** Los digitos visibles del receptor (3 o mas) son el final del numero configurado, o al reves. */
export const numberMatches = (receptor, number) => {
    const seen = digitsOf(receptor);
    const expected = digitsOf(number);
    if (seen.length < 3 || expected.length < 3) return false;
    return expected.endsWith(seen) || seen.endsWith(expected);
};

/**
 * @param {string|null} receptor lo que leyo la IA
 * @param {Array<{ holder?: string|null, number?: string|null }>} methods metodos de pago configurados
 * @returns {{ applicable: boolean, matches: boolean }} `applicable` es false si no hay titular ni
 *   numero contra los que comparar (no se puede exigir).
 */
export const checkReceiver = (receptor, methods = []) => {
    const references = methods.filter((method) => method?.holder || method?.number);
    if (references.length === 0) return { applicable: false, matches: true };

    const matches = references.some((method) =>
        (method.holder && nameMatches(receptor, method.holder)) || (method.number && numberMatches(receptor, method.number)));
    return { applicable: true, matches };
};

/** Texto de la IA apto para el motivo que ve el administrador en su panel (sin marcado ni control). */
export const safeText = (value, max = 50) => String(value ?? '')
    .replace(/[^\p{L}\p{N} .,'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
