import PaymentModel from '#Models/payment_model.js';
import UserModel from '#Models/user_model.js';
import { settings } from '#Config/settings.js';
import { sendMail } from '#Libs/mailer.js';
import { buildActiveSuscription } from '#Libs/suscription_activation.js';
import { appendSuscriptionHistoryEntry, buildSuscriptionHistoryEntry } from '#Libs/suscription_history.js';

// Activacion de un plan pagado. Port de #Services/suscription-activation.service.js del
// monolito, con las mismas reglas (si cambian alla, cambiar aqui):
//  - 'Renovar'/'Actualizar' encadenan el periodo nuevo al vigente si le queda tiempo; si
//    ya vencio, arranca hoy. Se archiva el ciclo anterior en `suscription_history` sin
//    duplicar (#Libs/suscription_history.js, copia del monolito).
//  - Todo plan con duracion recibe fecha de fin.
//  - Ciclo nuevo, avisos nuevos: se reinician los flags del cron de vencimiento.
// Diferencia: aqui se guarda primero y el correo sale despues, sin await (en el monolito
// se esperaba al SMTP antes de guardar).

const PAID_PAYMENT_STATUS = ['Completo', 'Completado'];
const RENEWAL_TRANSACTION_TYPES = ['Renovar', 'Actualizar'];

export const getStartAndEndDateSuscription = async (payment, plan, user, now = new Date()) => {
    let startDateSuscription = now;
    let endDateSuscription = null;
    const suscriptionHistory = [];

    if (RENEWAL_TRANSACTION_TYPES.includes(payment.transaction_type)) {
        const currentEndDate = user.suscription?.end_date ? new Date(user.suscription.end_date) : null;
        if (currentEndDate && !Number.isNaN(currentEndDate.valueOf()) && currentEndDate > now) {
            startDateSuscription = currentEndDate;
        }

        // El ultimo pago pagado que NO es el que se esta activando.
        const oldPayment = await PaymentModel.findOne({ _id: { $ne: payment._id }, user_id: user._id, status: { $in: PAID_PAYMENT_STATUS } })
            .sort({ created_at: -1 })
            .lean()
            .exec();
        // Sin pago previo (plan asignado a mano, pago depurado) no hay ciclo que archivar.
        if (oldPayment) suscriptionHistory.push(buildSuscriptionHistoryEntry(user.suscription, oldPayment));
    }

    if (plan.duration_months) {
        endDateSuscription = new Date(new Date(startDateSuscription).setMonth(new Date(startDateSuscription).getMonth() + plan.duration_months));
    }

    return { startDateSuscription, endDateSuscription, suscriptionHistory };
};

/**
 * Activa el plan del pago aprobado y lo guarda en el usuario. `payment` aun no esta
 * guardado como pagado (o ya lo esta): en ambos casos se excluye del historial.
 * @returns {Promise<object>} la nueva `user.suscription`
 */
export const activateSubscription = async ({ userId, payment, plan }) => {
    const user = await UserModel.findById(userId).exec();
    if (!user) throw new Error(`Usuario ${userId} no encontrado al activar la suscripción`);

    const dates = await getStartAndEndDateSuscription(payment, plan, user);

    user.suscription = buildActiveSuscription(plan, payment, dates);
    user.notification_subscription_renovation = false;
    user.notification_subscription_expiration = false;
    user.suscription_history = dates.suscriptionHistory.reduce(appendSuscriptionHistoryEntry, user.suscription_history ?? []);
    user.suscription_notified = true;
    await user.save();

    // Misma plantilla de confirmacion que la web.
    void sendMail({
        to: user.email,
        subject: 'Confirmación de suscripción',
        template: 'email_verification_suscription',
        data: { user: { username: user.username }, WEB_URL: settings.app.webUrl, suscription: user.suscription },
    });

    return user.suscription;
};
