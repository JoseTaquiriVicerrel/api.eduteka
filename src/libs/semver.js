// Comparacion de versiones "x.y.z" (sin prerelease). Suficiente para el header
// X-App-Version; una cadena con otro formato no se puede comparar y devuelve null.

const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/** -1, 0 o 1 segun `a` sea menor, igual o mayor que `b`; null si alguna no se puede leer. */
export const compareVersions = (a, b) => {
    const left = parse(a);
    const right = parse(b);
    if (!left || !right) return null;
    for (let i = 0; i < 3; i += 1) {
        if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
    }
    return 0;
};
