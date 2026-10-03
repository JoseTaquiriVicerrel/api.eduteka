/**
 * Normaliza un texto para compararlo: minusculas, sin tildes, sin puntuacion
 * (salvo `.` y `:`), un solo espacio entre palabras.
 *
 * Modulo hoja, sin imports: lo usan servicios de `src/` y scripts de
 * mantenimiento. Vivia en `scripts/lib/topic_keywords.js`, pero `src/` no debe
 * importar de `scripts/`; el script lo sigue exportando desde aqui.
 */
export const foldText = (text) =>
    String(text ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s.:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
