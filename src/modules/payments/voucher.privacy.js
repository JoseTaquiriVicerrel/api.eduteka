// Minimizacion de datos del comprobante que se envia a la IA (Gemini). La captura puede
// llevar metadatos que la lectura no necesita: ubicacion GPS, modelo del telefono, fecha de
// captura, miniaturas, texto incrustado. Se quitan de la COPIA que viaja al proveedor; el
// archivo que se guarda para el administrador (#Libs/capture_storage.js) no se modifica.
//
// No se recodifica la imagen (no cambia ni un pixel): solo se omiten segmentos opcionales.
// Ante cualquier estructura inesperada se devuelve el buffer original.

const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]); // APP1 (EXIF/XMP), APP13 (IPTC), comentarios
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const stripJpeg = (buffer) => {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

    const parts = [buffer.subarray(0, 2)];
    let position = 2;
    while (position < buffer.length) {
        if (buffer[position] !== 0xff) return null;
        const marker = buffer[position + 1];
        if (marker === 0xff) { position += 1; continue; } // relleno

        // Inicio del barrido de datos: lo que sigue es imagen comprimida, se copia tal cual.
        if (marker === 0xda || marker === 0xd9) {
            parts.push(buffer.subarray(position));
            return Buffer.concat(parts);
        }
        // Marcadores sin longitud.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
            parts.push(buffer.subarray(position, position + 2));
            position += 2;
            continue;
        }

        if (position + 4 > buffer.length) return null;
        const end = position + 2 + buffer.readUInt16BE(position + 2);
        if (end > buffer.length) return null;
        if (!JPEG_DROP.has(marker)) parts.push(buffer.subarray(position, end));
        position = end;
    }
    return null;
};

const stripPng = (buffer) => {
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

    const parts = [buffer.subarray(0, 8)];
    let position = 8;
    while (position + 12 <= buffer.length) {
        const end = position + 12 + buffer.readUInt32BE(position);
        if (end > buffer.length) return null;
        const type = buffer.toString('latin1', position + 4, position + 8);
        if (!PNG_DROP.has(type)) parts.push(buffer.subarray(position, end));
        position = end;
        if (type === 'IEND') return Buffer.concat(parts);
    }
    return null;
};

/** Copia del comprobante sin metadatos opcionales (JPEG y PNG). Cualquier otra cosa, tal cual. */
export const stripMetadata = (buffer) => {
    try {
        return stripJpeg(buffer) ?? stripPng(buffer) ?? buffer;
    } catch {
        return buffer;
    }
};
