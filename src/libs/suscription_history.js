/**
 * Forma canonica de las entradas de `User.suscription_history` y su insercion
 * sin duplicados.
 *
 * El historial lo escriben tres flujos que antes no se conocian entre si: la
 * renovacion (#Controllers/admin/suscription.admin.controllers.js), el cron que
 * finaliza suscripciones vencidas (#Libs/cron.js) y el script de saneo
 * (scripts/fix_suscription_status.js). Sin un criterio comun, el ciclo que el
 * cron archiva al vencer se volvia a archivar cuando el usuario renovaba.
 */

// Un ciclo queda identificado por su fecha de fin; si no la tiene (Lifetime),
// por el pago que lo origino.
const isSameCycle = (a, b) => {
    if ( a?.end_date && b?.end_date ) {
        return new Date(a.end_date).getTime() === new Date(b.end_date).getTime();
    }
    return Boolean(a?.payment_id) && a.payment_id === b?.payment_id;
}

// `suscription` es el ciclo que termina (el `user.suscription` vigente) y
// `payment` el ultimo pago que lo cubrio, que puede no existir (suscripcion
// asignada a mano, pago depurado): en ese caso se archiva igual, sin los datos
// economicos, porque las fechas del ciclo son lo que da sentido al historial.
const buildSuscriptionHistoryEntry = (suscription, payment = null) => ({
    "payment_id": payment?._id ?? null,
    "subscription_id": payment?.subscription_id ?? null,
    "start_date": suscription?.start_date ?? null,
    "end_date": suscription?.end_date ?? null,
    "payment_method": payment?.payment_method ?? null,
    "payment_type": payment?.transaction_type ?? null,
    "amount_paid": payment?.amount ?? null,
    "status": "Finalizado",
});

// Devuelve un array nuevo con la entrada agregada, o el historial tal cual si
// ese ciclo ya estaba archivado. Mantiene idempotentes tanto al cron como al
// script: volver a correrlos no infla el historial.
const appendSuscriptionHistoryEntry = (history, entry) => {
    const current = Array.isArray(history) ? history : [];
    if ( current.some((item) => isSameCycle(item, entry)) ) return current;
    return [ ...current, entry ];
}

export { buildSuscriptionHistoryEntry, appendSuscriptionHistoryEntry, isSameCycle };
