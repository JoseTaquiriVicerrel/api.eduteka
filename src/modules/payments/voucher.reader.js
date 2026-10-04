import { imageSize } from 'image-size';
import { settings } from '#Config/settings.js';
import { logger } from '#Libs/logger.js';

// Lectura del comprobante (captura de Yape/Plin) con IA. Extrae los mismos datos que la
// web (#Services/providers/gemini_provider.js del monolito): monto, fecha, receptor y
// numero de operacion. NUNCA lanza: ante cualquier fallo devuelve null y el pago pasa a
// revision manual.
//
// Se llama a la API REST de Gemini directamente (sin SDK) y con la imagen en memoria: el
// comprobante se lee antes de escribirse a disco.

const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

const PROMPT = 'Analiza este comprobante de pago (Yape, Plin o transferencia) y extrae en formato JSON: '
    + '{ "monto": number, "fecha": "YYYY-MM-DD", "receptor": "nombre", "numero_operacion": "texto" }. '
    + 'El monto es el importe pagado en soles. Si no puedes encontrar un dato, ponlo como null. Responde SOLO con el JSON.';

/** Lecturas fijadas por las pruebas (proveedor `memory`): un objeto, null o una funcion(buffer). */
export const memoryReader = { next: null };

const mimeOf = (buffer) => {
    try {
        return imageSize(buffer).type === 'png' ? 'image/png' : 'image/jpeg';
    } catch {
        return 'image/jpeg';
    }
};

const toAmount = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    // "S/ 15.00", "15,00", "1,250.50"
    const cleaned = value.replace(/[^\d.,]/g, '');
    const normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '');
    const amount = Number.parseFloat(normalized);
    return Number.isFinite(amount) ? amount : null;
};

const toText = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text && text.toLowerCase() !== 'null' ? text : null;
};

/** Forma canonica de lo que devuelve la IA (es texto libre: se normaliza todo). */
export const normalizeVoucher = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    return {
        monto: toAmount(raw.monto),
        fecha: toText(raw.fecha),
        receptor: toText(raw.receptor),
        numero_operacion: toText(raw.numero_operacion),
    };
};

const readWithGemini = async (buffer) => {
    const { geminiApiKey, model, timeoutMs } = settings.paymentAi;
    const response = await fetch(GEMINI_URL(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
        body: JSON.stringify({
            contents: [{
                role: 'user',
                parts: [
                    { inline_data: { mime_type: mimeOf(buffer), data: buffer.toString('base64') } },
                    { text: PROMPT },
                ],
            }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Gemini respondio ${response.status}: ${(await response.text()).slice(0, 300)}`);

    const body = await response.json();
    const text = (body?.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
    return JSON.parse(text.replace(/```json|```/g, '').trim());
};

/** @returns {Promise<{monto, fecha, receptor, numero_operacion}|null>} */
export const readVoucher = async (buffer) => {
    try {
        switch (settings.paymentAi.provider) {
            case 'gemini':
                return normalizeVoucher(await readWithGemini(buffer));
            case 'memory': {
                const { next } = memoryReader;
                return normalizeVoucher(typeof next === 'function' ? await next(buffer) : next);
            }
            default:
                return null;
        }
    } catch (error) {
        logger.warn({ err: error.message, provider: settings.paymentAi.provider }, 'No se pudo leer el comprobante con IA');
        return null;
    }
};
