import { format_date } from "#Libs/misc.js";
import { pickPlanLimits } from "#Libs/plan_limits.js";

/**
 * Forma canonica de `User.suscription` al activarse un plan.
 *
 * La activan tres flujos: la compra y la renovacion aprobadas por la IA
 * (#Controllers/suscription.controllers.js) y la aprobacion manual del admin
 * (#Controllers/admin/suscription.admin.controllers.js). Antes cada uno armaba
 * el objeto a su manera y la compra por IA omitia la institucion, asi que el
 * plan institucional daba acceso a los examenes de todas las instituciones
 * (#Controllers/exam_download.controllers.js solo restringe si hay
 * `institution_id`).
 *
 * `start_date_on` / `end_date_on` se guardan formateados porque los leen el
 * perfil (partials/users/profile/suscription_tab.hbs) y el correo de
 * confirmacion.
 */
const buildActiveSuscription = (plan, payment, { startDateSuscription, endDateSuscription }) => {
    const suscription = {
        name: plan.name,
        start_date: startDateSuscription,
        end_date: endDateSuscription,
        status: "activo",
        start_date_on: format_date(startDateSuscription, false),
    };

    if (endDateSuscription) {
        suscription.end_date_on = format_date(endDateSuscription, false);
    }

    // Se copian al usuario: resolver un tope no consulta el plan, y editar el plan despues
    // no cambia a quien ya lo tiene hasta que renueve.
    suscription.audience = plan.audience ?? "Todos";
    const limits = pickPlanLimits(plan.limits);
    if (limits) suscription.limits = limits;

    if (plan.restricted_to_institution) {
        suscription.restricted_to_institution = true;
        suscription.institution_id = payment.institution_id;
    }

    return suscription;
};

export { buildActiveSuscription };
