/**
 * Reglas del cambio de plan con una suscripcion vigente.
 *
 * Al activarse un plan, `user.suscription` se reemplaza entero
 * (#Libs/suscription_activation.js): el acceso del plan nuevo rige desde ese
 * momento, aunque antes el periodo se fechaba despues del actual. Eso dejaba
 * dos fallos:
 *  - Pasar de Institucional a Semestral daba acceso general al instante, pero el
 *    detalle del plan decia que "empieza cuando termine el actual" y el perfil
 *    mostraba una fecha de inicio futura. Ahora la mejora empieza hoy (entre
 *    planes generales, los dias que le quedaban al actual se suman al final).
 *  - Pasar de un plan general a uno institucional (o a otra institucion) le
 *    quitaba al usuario, ese mismo dia, el acceso que ya habia pagado. Ahora se
 *    rechaza mientras el plan actual siga vigente.
 *  - De Institucional a un plan general se cobraba el precio completo. Ahora se
 *    cobra la diferencia (`prorationFor`): se descuenta lo que vale lo que le
 *    queda del Institucional y el plan nuevo corre desde hoy por su duracion
 *    completa (los dias restantes ya se pagaron con el descuento, no se suman).
 *
 * Copia de #Libs/plan_change.js del monolito (si cambian alla, cambiar aqui).
 * Funciones puras: las usan el detalle del plan, el pago y la activacion.
 */

const validDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date;
};

const addMonths = (date, months) => {
    const result = new Date(date);
    result.setMonth(result.getMonth() + months);
    return result;
};

/** Fin del plan actual si sigue activo y le queda tiempo; si no, null. */
export const runningEnd = (current, now = new Date()) => {
    if (current?.status !== 'activo') return null;
    const end = validDate(current.end_date);
    return end && end > now ? end : null;
};

const sameId = (a, b) => String(a ?? '') === String(b ?? '');

/**
 * Por que no se puede comprar `plan` ahora, o null si se puede.
 *
 * Solo se rechaza lo que reduce el acceso vigente: comprar un plan restringido
 * a una institucion mientras el actual da acceso general, o a otra institucion
 * distinta de la del plan actual. `institutionId` es la institucion elegida en
 * el checkout; en el detalle del plan aun no se conoce y se omite.
 */
export const planChangeBlock = (current, plan, institutionId = null, now = new Date()) => {
    const end = runningEnd(current, now);
    if (!end || !plan?.restricted_to_institution) return null;

    if (!current.restricted_to_institution) {
        return { code: 'narrower_plan', end_date: end };
    }
    if (institutionId && current.institution_id && !sameId(current.institution_id, institutionId)) {
        return { code: 'other_institution', end_date: end };
    }
    return null;
};

/**
 * Cambio a otro plan que no reduce el acceso, con el actual vigente: rige desde
 * hoy y suma los dias que le quedaban.
 */
export const isImmediateUpgrade = (current, plan, now = new Date()) => (
    Boolean(runningEnd(current, now))
    && current.name !== plan?.name
    && !plan?.restricted_to_institution
);

/** Cobro minimo de una mejora con descuento, en soles. */
export const MIN_UPGRADE_CHARGE = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Descuento por cambiar de un Institucional vigente a un plan general.
 *
 * `currentPlan` es el plan del catalogo que corresponde a `current` (por
 * nombre): de el salen el precio y la duracion del ciclo. Devuelve null cuando
 * no aplica, y el cambio se cobra a precio completo:
 *  - el plan actual no esta vigente, no es institucional, o el nuevo tambien lo es;
 *  - no se conoce el precio o la duracion del plan actual;
 *  - quedan mas dias que un ciclo (renovacion ya encadenada): descontar solo un
 *    ciclo le haria perder el otro, asi que se cobra completo y se suman los dias.
 *
 * El monto se redondea hacia arriba a soles enteros (se paga por Yape/Plin) y
 * nunca baja de MIN_UPGRADE_CHARGE. `credit` es el descuento real ya redondeado.
 */
export const prorationFor = ({ current, currentPlan, plan, now = new Date() }) => {
    const end = runningEnd(current, now);
    if (!end || !current.restricted_to_institution || plan?.restricted_to_institution) return null;
    if (current.name === plan?.name) return null;

    const currentPrice = Number(currentPlan?.price);
    const price = Number(plan?.price);
    if (!(currentPrice > 0) || !(price > 0)) return null;

    const months = Number(currentPlan.duration_months) || 0;
    const cycleStart = months ? addMonths(end, -months) : new Date(end.getTime() - (Number(currentPlan.duration_days) || 0) * DAY_MS);
    const cycleDays = Math.round((end - cycleStart) / DAY_MS);
    if (!(cycleDays > 0)) return null;

    const remainingDays = Math.ceil((end - now) / DAY_MS);
    if (remainingDays > cycleDays) return null;

    const value = currentPrice * remainingDays / cycleDays;
    const amount = Math.min(price, Math.max(MIN_UPGRADE_CHARGE, Math.ceil(price - value)));
    return {
        from_plan: current.name,
        remaining_days: remainingDays,
        regular_price: price,
        credit: price - amount,
        amount,
    };
};

/**
 * Periodo del plan que se activa.
 *  - Mejora con descuento (`prorated`): desde hoy por la duracion del plan.
 *  - Mejora inmediata sin descuento: desde hoy hasta el fin actual + la duracion.
 *  - Renovacion (mismo plan) con el actual vigente: se encadena al fin actual.
 *  - Lo demas (compra, plan vencido): desde hoy.
 * Sin `duration_months` no hay fecha de fin.
 */
export const periodFor = ({ transactionType, current, plan, now = new Date(), prorated = false }) => {
    const months = Number(plan?.duration_months) || 0;
    if (prorated) return { start: now, end: months ? addMonths(now, months) : null };

    const end = runningEnd(current, now);
    const chained = Boolean(end) && ['Renovar', 'Actualizar'].includes(transactionType);

    if (chained && isImmediateUpgrade(current, plan, now)) {
        return { start: now, end: months ? addMonths(end, months) : null };
    }
    const start = chained ? end : now;
    return { start, end: months ? addMonths(start, months) : null };
};

export const planChangeBlockMessage = (block, formatDate) => {
    if (!block) return null;
    const until = formatDate(block.end_date);
    return block.code === 'other_institution'
        ? `Tu plan actual es de otra institución y está vigente hasta el ${until}. Podrás cambiar de institución cuando termine.`
        : `Tu plan actual te da acceso a todas las instituciones hasta el ${until}. Podrás pasar al plan institucional cuando termine, así no pierdes ese acceso.`;
};
