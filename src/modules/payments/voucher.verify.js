import OrderModel from '#Models/order_model.js';
import PaymentModel from '#Models/payment_model.js';
import UserSimulacrumModel from '#Models/user_simulacrum_model.js';
import { settings } from '#Config/settings.js';
import { del, setNX } from '#Libs/kv.js';
import { DAY_MS, parseQueryDate, startOfDay } from '#Libs/lima_time.js';
import { readVoucher } from './voucher.reader.js';

// Verificacion automatica de comprobantes. La comparten el checkout de la tienda, el pago
// de suscripciones y la inscripcion a simulacros de pago (en la web cada flujo tenia sus
// propias reglas: los simulacros ni siquiera miraban si el comprobante ya se habia usado).
//
// La IA lee el comprobante y se aprueba solo si TODO cuadra:
//   1. se lee el numero de operacion y no figura en ningun otro pago, pedido o inscripcion;
//   2. el monto coincide con el esperado (margen de S/ 1, como la web: la IA puede leer
//      mal los centimos);
//   3. la fecha es de hoy o de los ultimos PAYMENT_VOUCHER_MAX_AGE_DAYS dias (hora de Lima).
// Nunca rechaza: ante cualquier duda devuelve el motivo y el pago queda en revision manual.

export const AMOUNT_TOLERANCE = 1;
export const VOUCHER_REUSED_REASON = 'El comprobante ya fue usado en otro pago o pedido';

// Mientras un pago se procesa, su numero de operacion queda reservado: dos envios
// simultaneos del mismo comprobante no pueden aprobarse los dos.
const CLAIM_SECONDS = 120;

const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

/** Formas en que el mismo numero puede estar guardado (texto tal cual, solo digitos, numero). */
export const operationVariants = (numero) => {
    const raw = String(numero).trim();
    const digits = digitsOf(raw);
    const variants = new Set([raw]);
    if (digits) {
        variants.add(digits);
        const asNumber = Number(digits);
        if (Number.isSafeInteger(asNumber)) variants.add(asNumber);
    }
    return [...variants];
};

// Los mismos digitos con cualquier separador ("00777 001", "00777-001"): la IA no siempre
// copia el numero con el mismo formato.
const separatedDigitsRegex = (digits) => new RegExp(`^\\D*${digits.split('').join('\\D*')}\\D*$`);

/** El numero de operacion ya figura en otro pago de suscripcion, pedido o inscripcion. */
export const isVoucherReused = async (numero) => {
    const digits = digitsOf(numero);
    const candidates = operationVariants(numero);
    if (digits.length >= 4) candidates.push(separatedDigitsRegex(digits));
    const filter = { 'ai_analysis.numero_operacion': { $in: candidates } };
    const found = await Promise.all([
        PaymentModel.exists(filter).exec(),
        OrderModel.exists(filter).exec(),
        UserSimulacrumModel.exists(filter).exec(),
    ]);
    return found.some(Boolean);
};

const formatAmount = (value) => Number(value).toFixed(2);

/**
 * Reglas sobre la lectura de la IA. Pura salvo la consulta de reutilizacion.
 * @returns {Promise<{ approved: boolean, reason: string|null }>}
 */
export const assessVoucher = async (aiData, expectedAmount, { now = new Date(), reused } = {}) => {
    if (!aiData) return { approved: false, reason: 'Falló verificación IA' };

    if (!aiData.numero_operacion) return { approved: false, reason: 'No se pudo leer el número de operación' };
    if (reused ?? await isVoucherReused(aiData.numero_operacion)) return { approved: false, reason: VOUCHER_REUSED_REASON };

    if (!aiData.monto) return { approved: false, reason: 'No se pudo detectar el monto' };
    if (Math.abs(aiData.monto - expectedAmount) >= AMOUNT_TOLERANCE) {
        return { approved: false, reason: `Monto no coincide: esperado ${formatAmount(expectedAmount)} vs encontrado ${formatAmount(aiData.monto)}` };
    }

    const paidOn = parseQueryDate(aiData.fecha);
    if (!paidOn) return { approved: false, reason: 'No se pudo leer la fecha del pago' };
    const today = startOfDay(now);
    if (paidOn > today) return { approved: false, reason: `La fecha del comprobante (${aiData.fecha}) es posterior a hoy` };
    const maxAge = settings.paymentAi.voucherMaxAgeDays;
    if (today.getTime() - paidOn.getTime() > maxAge * DAY_MS) {
        return { approved: false, reason: `El comprobante es del ${aiData.fecha}: tiene más de ${maxAge} días` };
    }

    return { approved: true, reason: null };
};

/**
 * Lee y evalua un comprobante. `release()` libera la reserva del numero de operacion:
 * el llamador la invoca SIEMPRE (en un finally), despues de guardar el pago.
 *
 * @returns {Promise<{ aiData: object|null, approved: boolean, reason: string|null, release: () => Promise<void> }>}
 */
export const verifyVoucher = async (buffer, expectedAmount) => {
    const aiData = await readVoucher(buffer);

    let claimKey = null;
    let reused;
    if (aiData?.numero_operacion) {
        const key = `voucher:${digitsOf(aiData.numero_operacion) || aiData.numero_operacion}`;
        // Si otro envio ya lo tiene reservado, se trata como reutilizado.
        if (await setNX(key, CLAIM_SECONDS)) claimKey = key;
        else reused = true;
    }

    const release = async () => {
        if (claimKey) await del(claimKey);
    };

    try {
        const { approved, reason } = await assessVoucher(aiData, expectedAmount, { reused });
        return { aiData, approved, reason, release };
    } catch (error) {
        await release();
        throw error;
    }
};
