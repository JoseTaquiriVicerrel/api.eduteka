/**
 * Fuente unica de verdad del precio del carrito.
 *
 * El navegador lo importa como modulo estatico (`/js/store/pricing.js`) y el
 * servidor por el alias `#Public/js/store/pricing.js`, asi que ambos calculan
 * exactamente el mismo total. Antes cada lado tenia su propia formula y el
 * total guardado no coincidia con el mostrado, lo que rompia la verificacion
 * automatica del comprobante.
 *
 * Regla: el precio del producto es POR AREA. `quantity` no multiplica.
 */

const DISCOUNT_THRESHOLD = 2;
const DISCOUNT_RATE = 0.20;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const areaCount = (item) => (Array.isArray(item?.areas) ? item.areas.length : 0);

const itemSubtotal = (item) => round2((Number(item?.price) || 0) * areaCount(item));

const hasDiscount = (item) => item?.type === 'Examen' && areaCount(item) >= DISCOUNT_THRESHOLD;

const itemDiscount = (item) => (hasDiscount(item) ? round2(itemSubtotal(item) * DISCOUNT_RATE) : 0);

const itemTotal = (item) => round2(itemSubtotal(item) - itemDiscount(item));

const cartTotals = (items = []) => {
    const list = Array.isArray(items) ? items : [];
    const subtotal = round2(list.reduce((acc, item) => acc + itemSubtotal(item), 0));
    const discount = round2(list.reduce((acc, item) => acc + itemDiscount(item), 0));
    return { subtotal, discount, total: round2(subtotal - discount) };
};

export {
    DISCOUNT_THRESHOLD,
    DISCOUNT_RATE,
    round2,
    areaCount,
    itemSubtotal,
    hasDiscount,
    itemDiscount,
    itemTotal,
    cartTotals,
};
