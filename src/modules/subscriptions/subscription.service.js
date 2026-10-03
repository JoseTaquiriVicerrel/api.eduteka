import InstitutionModel from '#Models/institution_model.js';
import PaymentModel from '#Models/payment_model.js';
import SuscriptionModel from '#Models/suscription_model.js';
import UserModel from '#Models/user_model.js';
import { settings } from '#Config/settings.js';
import { ACTIVITY_ACTIONS } from '#Libs/activity_actions.js';
import { ApiError } from '#Libs/api_error.js';
import { hasActiveSuscription } from '#Libs/capabilities.js';
import { deleteCapture, saveCapture } from '#Libs/capture_storage.js';
import { MIN_EXAMS_INSTITUTION } from '#Libs/institution_suscription.js';
import { del, setNX } from '#Libs/kv.js';
import { sendMail } from '#Libs/mailer.js';
import { decoratePlans } from '#Libs/suscription_plans.js';
import { absoluteUrl } from '#Libs/urls.js';
import { logUserActivity } from '#Libs/user_activity.js';
import { serializeSuscription } from '#Serializers/user.serializer.js';

// Planes de suscripcion y su pago con comprobante. Las suscripciones se pagan con
// `Payment` (no con `Order`). El pago queda 'Pendiente' hasta que un administrador lo
// aprueba en el panel del monolito, que es quien activa el plan (fechas, historial,
// correo de confirmacion): la API no verifica comprobantes con IA.
//
// Vocabulario de `Payment` (lo comparte con el monolito, no se cambia):
//  - status: 'Pendiente' | 'Completo' (aprobado por IA) | 'Completado' (aprobado por el admin) | 'Cancelado'
//  - transaction_type: 'Compra' | 'Renovar' (mismo plan) | 'Actualizar' (otro plan). El
//    admin encadena el periodo nuevo al vigente solo con 'Renovar'/'Actualizar'.

export const CURRENCY = 'PEN';

const PAID_STATUS = ['Completo', 'Completado'];
const PAYMENT_METHODS = { yape: 'Yape', plin: 'Plin' };
const SUBSCRIBE_LOCK_SECONDS = 15;

const iso = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// --- Planes -----------------------------------------------------------------

const serializePlan = (plan) => ({
    id: plan._id,
    name: plan.name ?? null,
    slug: plan.slug ?? null,
    description: plan.description ?? null,
    price: Number(plan.price) || 0,
    currency: CURRENCY,
    duration_months: plan.duration_months ?? null,
    duration_days: plan.duration_days ?? null,
    per_month: plan.per_month ?? null,
    // El menor precio por mes entre los planes generales (#Libs/suscription_plans.js).
    best_value: Boolean(plan.best_value),
    is_current: Boolean(plan.is_current),
    restricted_to_institution: Boolean(plan.restricted_to_institution),
});

const PLAN_FIELDS = { name: 1, slug: 1, description: 1, price: 1, duration_months: 1, duration_days: 1, restricted_to_institution: 1 };

const loadDecoratedPlans = async (user) => {
    const plans = await SuscriptionModel.find({ state: true }, PLAN_FIELDS).sort({ price: 1, _id: 1 }).lean().exec();
    return decoratePlans(plans, { currentPlanName: user?.suscription?.name ?? null });
};

export const listPlans = async (user) => (await loadDecoratedPlans(user)).map(serializePlan);

// Instituciones que se pueden elegir en un plan restringido: las que tienen el minimo
// de examenes (mismo piso que la web, #Libs/institution_suscription.js).
const eligibleInstitutionFilter = () => ({ state: { $ne: false }, exams_count: { $gte: MIN_EXAMS_INSTITUTION } });

const listEligibleInstitutions = async () => {
    const docs = await InstitutionModel.find(eligibleInstitutionFilter(), { name: 1, abrev: 1, image: 1, exams_count: 1 })
        .sort({ exams_count: -1, name: 1 })
        .lean()
        .exec();
    return docs.map((doc) => ({
        id: doc._id,
        name: doc.name ?? null,
        abrev: doc.abrev ?? null,
        image: doc.image ? absoluteUrl(doc.image) : null,
        exams_count: doc.exams_count ?? 0,
    }));
};

const pendingPaymentOf = (user) => PaymentModel.findOne({ user_id: user._id, status: 'Pendiente' }).sort({ created_at: -1 }).lean().exec();

/**
 * Aviso de renovacion: si al plan actual le queda tiempo, el periodo nuevo arranca cuando
 * termine; si no, el dia en que se aprueba el pago (mismo criterio que la web).
 */
const renewalPreview = (current, plan) => {
    if (!current?.name) return null;
    const end = current.end_date ? new Date(current.end_date) : null;
    const running = hasActiveSuscription({ suscription: current }) && end !== null && end > new Date();
    return {
        current_plan: current.name,
        same_plan: current.name === plan.name,
        running,
        current_end_date: iso(end),
        starts_at: running ? iso(end) : null,
    };
};

export const getPlan = async ({ slug, user }) => {
    const plans = await loadDecoratedPlans(user);
    const plan = plans.find((entry) => entry.slug === slug);
    if (!plan) throw ApiError.notFound('No encontramos ese plan.');

    const [institutions, pending] = await Promise.all([
        plan.restricted_to_institution ? listEligibleInstitutions() : null,
        user ? pendingPaymentOf(user) : null,
    ]);

    return {
        ...serializePlan(plan),
        // Solo en planes restringidos: entre cuales se puede elegir.
        institutions,
        min_exams_institution: plan.restricted_to_institution ? MIN_EXAMS_INSTITUTION : null,
        pending_payment: pending ? await serializePayment(pending) : null,
        renewal: user ? renewalPreview(user.suscription, plan) : null,
    };
};

// --- Pagos ------------------------------------------------------------------

const paymentState = (status) => {
    if (PAID_STATUS.includes(status)) return 'paid';
    if (status === 'Cancelado') return 'rejected';
    return 'pending';
};

const serializePayment = async (payment, plan = null) => {
    const resolvedPlan = plan ?? (payment.subscription_id
        ? await SuscriptionModel.findById(payment.subscription_id, { name: 1, slug: 1 }).lean().exec()
        : null);
    const state = paymentState(payment.status);
    return {
        id: payment._id,
        status: state,
        plan: resolvedPlan ? { id: resolvedPlan._id, name: resolvedPlan.name ?? null, slug: resolvedPlan.slug ?? null } : null,
        amount: payment.amount ?? 0,
        currency: CURRENCY,
        payment_method: payment.payment_method ?? null,
        transaction_type: payment.transaction_type ?? null,
        institution_id: payment.institution_id ?? null,
        // Motivo del rechazo que escribe el administrador. `status_reason` es interno.
        reason: state === 'rejected' ? payment.message ?? null : null,
        created_at: iso(payment.created_at),
    };
};

const assertPaymentsEnabled = () => {
    if (!settings.app.paymentsEnabled) throw ApiError.forbidden('Los pagos no están disponibles por ahora.');
};

const institutionError = (message) => ApiError.validation([{ field: 'institution_id', message }]);

// Institucion del pago: la elegida, o en un plan restringido la del plan restringido que
// ya tiene el usuario (renovacion). Un plan restringido solo se vende para instituciones
// con el minimo de examenes.
const resolveInstitution = async (plan, user, requested) => {
    const current = user.suscription;
    const institutionId = requested
        ?? (plan.restricted_to_institution && current?.restricted_to_institution ? current.institution_id ?? null : null);

    if (plan.restricted_to_institution) {
        if (!institutionId) throw institutionError('Elige la institución de tu suscripción.');
        const eligible = await InstitutionModel.exists({ _id: institutionId, ...eligibleInstitutionFilter() }).exec();
        if (!eligible) {
            throw institutionError(`La suscripción institucional solo está disponible para instituciones con ${MIN_EXAMS_INSTITUTION} o más exámenes.`);
        }
        return institutionId;
    }

    if (institutionId && !(await InstitutionModel.exists({ _id: institutionId }).exec())) {
        throw institutionError('Esa institución no existe.');
    }
    return institutionId;
};

const createPayment = async ({ req, user, plan, body, capture }) => {
    assertPaymentsEnabled();
    if (!capture) throw ApiError.validation([{ field: 'payment_proof', message: 'Sube la captura de tu pago para continuar.' }]);

    const institutionId = await resolveInstitution(plan, user, body.institution_id);
    const previous = user.suscription?.name ?? null;
    const transactionType = !previous ? 'Compra' : previous === plan.name ? 'Renovar' : 'Actualizar';

    const lockKey = `subscription-lock:${user._id}`;
    if (!(await setNX(lockKey, SUBSCRIBE_LOCK_SECONDS))) throw ApiError.conflict('Tu pago aún se está procesando.');

    try {
        // Un segundo envio con el primero en revision creaba otro pago (y otro aviso) por la misma compra.
        if (await PaymentModel.exists({ user_id: user._id, status: 'Pendiente' }).exec()) {
            throw ApiError.conflict('Ya tienes un pago en revisión. Te avisaremos por correo cuando se active tu suscripción.');
        }

        const paymentCapture = await saveCapture(capture, { target: 'subscription', field: 'payment_proof' });
        let payment;
        try {
            payment = await PaymentModel.create({
                user_id: user._id,
                subscription_id: plan._id,
                institution_id: institutionId ?? undefined,
                // El precio vigente se congela en el pago.
                amount: plan.price,
                payment_method: PAYMENT_METHODS[body.payment_method ?? 'yape'],
                status: 'Pendiente',
                transaction_type: transactionType,
                payment_capture: paymentCapture,
            });
        } catch (error) {
            await deleteCapture(paymentCapture);
            throw error;
        }

        if (institutionId) await UserModel.updateOne({ _id: user._id }, { $set: { university: institutionId } }).exec();

        notifyPayment(user, plan, payment);
        void logUserActivity(req, user, {
            action: previous ? ACTIVITY_ACTIONS.SUBSCRIPTION_RENEWAL_REQUESTED : ACTIVITY_ACTIONS.SUBSCRIPTION_PURCHASE_REQUESTED,
            target_type: 'payment',
            target_id: payment._id,
            target_name: plan.name,
            metadata: { amount: payment.amount, transaction_type: transactionType, payment_status: payment.status, auto_approved: false },
        });

        return serializePayment(payment.toObject(), plan);
    } finally {
        await del(lockKey);
    }
};

// Sin await: el pago ya existe y un fallo de correo no puede devolver error.
const notifyPayment = (user, plan, payment) => {
    void sendMail({
        to: user.email,
        subject: 'Recibimos tu comprobante',
        template: 'api_subscription_payment_received',
        data: { username: user.username, plan: plan.name, amount: Number(payment.amount).toFixed(2) },
    });
    if (settings.adminEmail) {
        void sendMail({
            to: settings.adminEmail,
            subject: 'Notificación de suscripción',
            template: 'api_subscription_payment_review',
            data: {
                email: user.email,
                plan: plan.name,
                amount: Number(payment.amount).toFixed(2),
                payment_method: payment.payment_method,
                transaction_type: payment.transaction_type,
                payment_id: payment._id,
            },
        });
    }
};

export const subscribe = async ({ req, user, slug, body, capture }) => {
    const plan = await SuscriptionModel.findOne({ slug, state: true }).lean().exec();
    if (!plan) throw ApiError.notFound('No encontramos ese plan.');
    return createPayment({ req, user, plan, body, capture });
};

/** Renueva el plan actual del usuario (el mismo plan, por nombre, si sigue a la venta). */
export const renew = async ({ req, user, body, capture }) => {
    const current = user.suscription?.name;
    if (!current) throw ApiError.conflict('No tienes un plan para renovar. Elige uno en el catálogo.');

    const plan = await SuscriptionModel.findOne({ name: current, state: true }).sort({ price: 1 }).lean().exec();
    if (!plan) throw ApiError.conflict('Tu plan ya no está disponible. Elige otro en el catálogo.');
    return createPayment({ req, user, plan, body, capture });
};

/**
 * En que quedo el ultimo pago y el estado del plan. `state`:
 *  none (nunca tuvo plan ni pago) | pending | active | expired | rejected
 * Sin pagos (plan asignado a mano, pago depurado) se mira solo el plan.
 */
export const getStatus = async (user) => {
    const payment = await PaymentModel.findOne({ user_id: user._id }).sort({ created_at: -1 }).lean().exec();
    const active = hasActiveSuscription(user);

    let state;
    if (!payment) state = active ? 'active' : user.suscription?.name ? 'expired' : 'none';
    else if (PAID_STATUS.includes(payment.status)) state = active ? 'active' : 'expired';
    else if (payment.status === 'Cancelado') state = 'rejected';
    else state = 'pending';

    return {
        state,
        subscription: serializeSuscription(user.suscription),
        last_payment: payment ? await serializePayment(payment) : null,
    };
};
