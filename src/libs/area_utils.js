// Conectores que se quedan en minuscula al formatear el nombre del area:
// "HISTORIA DEL PERU" -> "Historia del Perú", no "Historia Del Perú".
const CONECTORES = new Set([
    'de', 'del', 'la', 'las', 'lo', 'los', 'el', 'y', 'e', 'o', 'u',
    'a', 'al', 'en', 'para', 'por', 'con'
]);

/**
 * Nombre de presentacion del area: "LENGUAJE" -> "Lenguaje".
 * Conserva tildes y limpia puntuacion sobrante al final ("... INTERNACIONAL,").
 *
 * La clave canonica del area sigue siendo `slug` (convertSlug), que es tambien
 * lo que usan las rutas /preguntas/area/:slug.
 */
export const formatAreaName = (name = '') => {
    const limpio = name
        .toString()
        .replace(/\s+/g, ' ')
        .replace(/\s+([,;.])/g, '$1')
        .replace(/[,;.\s]+$/, '')
        .trim();

    if (!limpio) return '';

    // Se recorre palabra por palabra respetando espacios y guiones internos para
    // que "LÓGICO-MATEMÁTICA" quede "Lógico-Matemática".
    return limpio.toLocaleLowerCase('es').replace(/[^\s-]+/g, (palabra, offset) => {
        const base = palabra.replace(/[^a-záéíóúüñ]/g, '');
        if (offset > 0 && CONECTORES.has(base)) return palabra;
        return palabra.charAt(0).toLocaleUpperCase('es') + palabra.slice(1);
    });
};
