/**
 * Formato del campo `topic` de una pregunta. Modulo hoja: no importa modelos ni
 * servicios (solo otras libs), para que lo puedan usar controladores, servicios
 * y scripts.
 *
 * `topic` es texto libre y llega en tres formas distintas segun quien escriba:
 *
 *   - Texto plano desde los <input name="topic"> de los formularios.
 *   - Array de strings o de objetos {value} desde Tagify, que es lo que manda
 *     el editor publico (#Controllers/question.controllers.js).
 *   - Varios temas unidos por coma dentro de un solo string, resultado de que
 *     ese mismo editor guarde con `topics.join(',')`.
 *
 * Esa tercera forma es la que rompe cualquier `$group: { _id: '$topic' }`: un
 * unico "Algebra,Funciones" aparece como un tema mas en los desplegables y en
 * los conteos. Aqui vive el unico conocimiento del sistema sobre ese formato,
 * para que el dia que se normalice contra el catalogo de temas haya un solo
 * sitio que tocar.
 */

import { formatAreaName } from './area_utils.js';

// Siglas que se escriben en mayusculas aunque el resto del nombre se capitalice.
// Clave en minusculas, valor tal como se muestra.
const SIGLAS = new Map([
    'mru', 'mruv', 'mcu', 'mcuv', 'mcd', 'mcm', 'adn', 'arn', 'atp',
    'pea', 'pbi', 'pbe', 'onu', 'oea', 'iupac', 'igv', 'sunat'
].map((s) => [s, s.toUpperCase()]).concat([['ph', 'pH']]));

// Numerales romanos de dos letras o mas ("Siglo XXI", "Guerra Mundial II").
// Los de una letra se dejan: "I", "V" o "X" sueltos son ambiguos.
const ROMANO = /^(?=[ivxlcdm]{2,}$)m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
// Palabras castellanas que la regla anterior tomaria por numerales.
const NO_ROMANOS = new Set(['mi', 'di', 'vi', 'mix', 'dic', 'lid', 'mil', 'civil']);

/**
 * Nombre de presentacion de UN tema, con la convencion del catalogo de areas
 * (`formatAreaName`): "PLAN DE REDACCIÓN" -> "Plan de Redacción", "SINÓNIMOS"
 * -> "Sinónimos". Conserva tildes y deja los conectores en minuscula.
 *
 * Diferencias con las areas, que aqui si aparecen:
 *   - Siglas conocidas ("MRUV", "MCM", "pH") y numerales romanos ("XXI").
 *   - Si el texto original mezcla mayusculas y minusculas, las palabras que
 *     alguien escribio enteras en mayusculas se respetan: son siglas que la
 *     lista no conoce ("Crisis de la PEA").
 *
 * Recibe un solo tema. La coma NO forma parte del nombre: en `topic` es el
 * separador entre temas (ver `splitTopicText`).
 */
export const formatTopicName = (name = '') => {
    const texto = String(name ?? '').replace(/\p{Cf}/gu, '');
    const mixto = texto !== texto.toLocaleUpperCase('es');
    const mayusculas = new Set(
        mixto ? (texto.match(/[^\s-]+/g) ?? []).map(nucleo).filter((w) => w.length > 1 && /\p{L}/u.test(w) && w === w.toLocaleUpperCase('es')) : []
    );

    return formatAreaName(texto).replace(/[^\s-]+/g, (palabra) => {
        const base = nucleo(palabra);
        const clave = base.toLocaleLowerCase('es');

        let forma = null;
        if (SIGLAS.has(clave)) forma = SIGLAS.get(clave);
        else if (ROMANO.test(clave) && !NO_ROMANOS.has(clave)) forma = base.toUpperCase();
        else if (mayusculas.has(base.toLocaleUpperCase('es'))) forma = base.toLocaleUpperCase('es');

        return forma && base ? palabra.replace(base, forma) : palabra;
    });
};

/**
 * Entre dos grafias del mismo tema (mismo slug) gana la de mayor puntaje: 1 si
 * lleva tildes, 0 si no ("Estadística" sobre "Estadistica"). No se cuentan las
 * tildes: una errata con una de mas ("Etímología") ganaria a la buena. Entre
 * dos grafias con tildes decide quien llama, normalmente por numero de preguntas.
 */
export const topicNameScore = (name = '') => ([...String(name)].some((ch) => ch.codePointAt(0) > 127) ? 1 : 0);

/** La palabra sin la puntuacion que la rodea: "(MRU)," -> "MRU". */
function nucleo(palabra) {
    return palabra.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Los trozos de un `topic`, vengan como vengan. Sin vacios ni duplicados. */
export const splitTopicText = (value) => {
    if (value === null || value === undefined) return [];

    const raw = Array.isArray(value)
        ? value.map((item) => (item && typeof item === 'object' ? item.value : item))
        : [value];

    const parts = raw
        .flatMap((item) => String(item ?? '').split(/[,;]/))
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

    return [...new Set(parts)];
};

/**
 * Valor listo para guardar en `question.topic`: los trozos unidos por ', '.
 * Devuelve null cuando no hay nada, no '' — una cadena vacia es indistinguible
 * de un tema borrado y es justo lo que dejaba el bug de updateQuestionController.
 */
export const cleanTopicText = (value) => {
    const parts = splitTopicText(value);
    return parts.length ? parts.join(', ') : null;
};
