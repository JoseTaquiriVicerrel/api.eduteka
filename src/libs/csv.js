/**
 * Utilidades para los export CSV de los paneles admin.
 *
 * Vivian dentro de #Controllers/admin/download.admin.controllers.js hasta que
 * el panel del log de actividad necesito exactamente lo mismo. Es escapado de
 * CSV: si se duplica, se duplica tambien el proximo bug de comillas.
 */

// Excel en es-ES abre el CSV con la codificacion del sistema si no encuentra
// BOM, y las tildes salen rotas.
const BOM = '\uFEFF';

/**
 * Escapa un valor para una celda CSV separada por comas.
 *
 * Se entrecomilla solo si aparece un separador, una comilla o un salto de
 * linea; entrecomillar de mas es valido pero ensucia el archivo.
 */
const csvCell = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",;\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/**
 * Arma el archivo completo: BOM, cabeceras y filas ya escapadas, con CRLF.
 */
const buildCsv = (headers, rows) => BOM + [
    headers.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
].join('\r\n');

export { BOM, csvCell, buildCsv };
