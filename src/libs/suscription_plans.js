/**
 * Presentacion de los planes en el catalogo (#Views/front/suscriptions.hbs) y
 * en el home (#Views/front/main.hbs).
 *
 * Antes cada tarjeta se titulaba "Pro", no decia la duracion y el plan
 * resaltado alternaba por posicion (`index % 2`), asi que el destacado no
 * significaba nada. Ahora cada plan dice cuanto dura y cuanto cuesta al mes, y
 * se destaca uno con un criterio que el usuario puede comprobar: el menor
 * precio por mes entre los planes que dan acceso a todas las instituciones.
 */

const round2 = (value) => Math.round(value * 100) / 100;

const perMonth = (plan) => {
    const months = Number(plan.duration_months);
    const price = Number(plan.price);
    if (!months || months <= 0 || !Number.isFinite(price)) return null;
    return round2(price / months);
};

/**
 * @param {object[]} plans  Planes activos (objetos planos).
 * @param {{ currentPlanName?: string|null }} [options]
 * @returns {object[]} Los mismos planes, en el mismo orden, con los campos de
 *   presentacion: `per_month`, `per_month_label`, `best_value`, `is_current`.
 */
const decoratePlans = (plans, { currentPlanName = null } = {}) => {
    const withMonthly = plans.map((plan) => ({ plan, monthly: perMonth(plan) }));

    // El institucional es mas barato pero da menos: compararlo con los
    // generales haria "mejor precio" a un plan que no sirve para todos.
    const candidates = withMonthly.filter(({ plan, monthly }) => monthly !== null && !plan.restricted_to_institution);
    const best = candidates.reduce((winner, current) => {
        if (!winner) return current;
        if (current.monthly < winner.monthly) return current;
        // Empate: el de mas meses, que es el que menos obliga a renovar.
        if (current.monthly === winner.monthly && Number(current.plan.duration_months) > Number(winner.plan.duration_months)) return current;
        return winner;
    }, null);

    return withMonthly.map(({ plan, monthly }) => ({
        ...plan,
        per_month: monthly,
        per_month_label: monthly === null ? null : monthly.toFixed(2),
        // Con un solo plan general no hay nada que comparar.
        best_value: Boolean(best) && candidates.length > 1 && plan === best.plan,
        is_current: Boolean(currentPlanName) && plan.name === currentPlanName,
    }));
};

export { decoratePlans, perMonth };
