import crypto from 'crypto';
export const normalizeText = (text) => {
    if (!text) return '';
    return text
        .toString()
        .toLowerCase()
        .normalize('NFD') // Normaliza caracteres Unicode (descompone acentos)
        .replace(/[\u0300-\u036f]/g, '') // Elimina los acentos
        .replace(/\s+/g, ' ') // Reemplaza espacios múltiples por uno solo
        .trim();
};

/**
 * Quita la MAQUETACION de un enunciado y conserva su CONTENIDO.
 *
 * `normalizeText` no toca las etiquetas, asi que el mismo enunciado daba textos
 * distintos segun por donde entrara: Quill guarda "<p>Capital del Peru</p>" y la
 * importacion desde PDF guarda "Capital del Peru". Con las etiquetas dentro, el
 * `hash` de las dos nunca coincidia y el aviso de duplicado no saltaba
 * precisamente en el caso mas probable. Este era el motivo por el que
 * `teacher_question.service.js` tuvo que inventarse `contentKey` en vez de usar
 * el `hash` del documento.
 *
 * LAS IMAGENES SE CONSERVAN, y no es un detalle: en el banco hay 27 grupos de
 * preguntas con el enunciado identico y la FIGURA distinta ("¿Cuantos
 * cuadrilateros como maximo hay en la figura mostrada?" sobre dos dibujos
 * diferentes, "¿Cual es el nombre del siguiente compuesto?" sobre dos formulas).
 * Borrando el <img> las dos quedan con el mismo hash y el flujo de duplicados
 * invita a fusionar dos preguntas que no son la misma. Se sustituye por
 * `[img:url]` para que la figura siga contando como parte del enunciado.
 */
export const stripQuestionMarkup = (html) => String(html ?? '')
    .replace(/<img[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, ' [img:$1] ')
    .replace(/<[^>]+>/g, ' ')
    // Los espacios duros son ruido de maquetacion igual que las etiquetas:
    // Quill los mete solo y el mismo texto pegado a mano no los lleva.
    .replace(/&nbsp;/gi, ' ');

/**
 * Forma canonica del texto de una pregunta. Es lo que se guarda en
 * `question_raw` y lo que se hashea en `hash`, de modo que se mantiene el
 * invariante `hash === md5(question_raw)`.
 *
 * Es idempotente: aplicarla sobre un texto ya normalizado devuelve lo mismo, que
 * es de lo que depende `validateDuplicate` al hashear su propio
 * `normalizedText`.
 */
export const normalizeQuestionText = (html) => normalizeText(stripQuestionMarkup(html));

/**
 * Hash de deduplicacion de un enunciado.
 *
 * OJO: desde que normaliza quitando la maquetacion, un hash calculado con esta
 * funcion NO coincide con los que se guardaron antes. El banco se pone al dia
 * con `scripts/fix_question_defaults.js --strip-html`, que reescribe
 * `question_raw` y `hash` a la vez.
 */
export const generateHash = (text) => {
    const normalized = normalizeQuestionText(text);
    return crypto.createHash('md5').update(normalized).digest('hex');
};

export const escapeRegex = (string) => {
    if (!string) return '';
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

export const safeSearchRegex = (string, max = 120) => {
    if (!string) return new RegExp('');
    const sanitized = String(string).slice(0, max);
    return new RegExp(escapeRegex(sanitized), 'i');
};
