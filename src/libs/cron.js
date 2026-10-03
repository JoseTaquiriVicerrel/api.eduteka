import cron from "node-cron";
import UserModel from "#Models/user_model.js";
import PaymentModel from "#Models/payment_model.js";
import sendMailNotification from "#Libs/send_mail.js";
import { buildSuscriptionHistoryEntry, appendSuscriptionHistoryEntry } from "#Libs/suscription_history.js";
import { logActivityMany } from "#Libs/activity_log.js";
import { ACTIVITY_ACTIONS } from "#Libs/activity_actions.js";

const DAY_MS = 1000 * 3600 * 24;
// Dias de antelacion con los que se avisa del vencimiento.
const RENOVATION_WINDOW_DAYS = 7;
const MAIL_FROM = 'eduteka.noresponder@gmail.com';
// Los dos vocabularios de `Payment.status` que significan "cobrado" (mismo
// criterio que PAID_PAYMENT_STATUS en los controladores de suscripcion).
const PAID_PAYMENT_STATUS = ['Completo', 'Completado'];

// Filtro comun de fecha de fin. `$type: "date"` descarta las suscripciones
// lifetime (end_date null), los documentos sin el campo y las fechas que
// quedaron guardadas como string: en el orden de comparacion de BSON null es
// menor que cualquier Date, asi que un `$lte` pelado se los llevaria por
// delante y finalizaria suscripciones que no vencen nunca.
const endDateFilter = (range) => ({ "$type": "date", ...range });

// Suscripciones cuyo periodo ya vencio pero siguen sin marcar como finalizadas.
// Se exporta para que scripts/fix_suscription_status.js pueda contar en dry-run
// con el mismo criterio con el que despues se escribe.
const expiredSuscriptionsFilter = (now) => ({
    "suscription.end_date": endDateFilter({ "$lte": now }),
    "suscription.status": { "$ne": "Finalizado" },
});

// Vencidas a las que todavia no se les envio el aviso de fin. No coincide con el
// filtro de arriba: un usuario puede estar ya "Finalizado" y sin avisar, o
// avisado en un ciclo anterior y vuelto a vencer.
const pendingExpirationMailFilter = (now) => ({
    "suscription.end_date": endDateFilter({ "$lte": now }),
    "notification_subscription_expiration": { "$ne": true },
});

// Arma el cierre de cada suscripcion vencida: el estado "Finalizado" y, si el
// ciclo que termina no estaba archivado, su entrada en `suscription_history`.
// Se separa del write para que scripts/fix_suscription_status.js pueda mostrar
// en dry-run exactamente lo que despues se va a escribir.
//
// Son tres consultas en total, no una por usuario: el numero de idas a la base
// no crece con la cantidad de suscriptores.
const planExpiredSuscriptionsClosure = async (now) => {

    const expired = await UserModel.find(
        expiredSuscriptionsFilter(now),
        { username: 1, email: 1, suscription: 1, suscription_history: 1 },
    ).lean().exec();

    if ( !expired.length ) return [];

    // Ultimo pago cobrado de cada uno, para los datos economicos del ciclo.
    // `Payment.status` es un String libre y conviven dos vocabularios
    // ('Completo' del flujo de usuario, 'Completado' del flujo admin).
    const payments = await PaymentModel.find({
        user_id: { "$in": expired.map((user) => user._id) },
        status: { "$in": PAID_PAYMENT_STATUS },
    }, { user_id: 1, subscription_id: 1, payment_method: 1, transaction_type: 1, amount: 1 })
        .sort({ created_at: -1 }).lean().exec();

    const lastPaymentByUser = new Map();
    for ( const payment of payments ) {
        if ( !lastPaymentByUser.has(payment.user_id) ) lastPaymentByUser.set(payment.user_id, payment);
    }

    return expired.map((user) => {
        const entry = buildSuscriptionHistoryEntry(user.suscription, lastPaymentByUser.get(user._id));
        const history = appendSuscriptionHistoryEntry(user.suscription_history, entry);

        return {
            user,
            history,
            // false cuando el ciclo ya figuraba en el historial: lo archivo la
            // renovacion, o una corrida anterior de este mismo cierre.
            archived: history !== user.suscription_history,
        };
    });
}

// Corta el acceso de toda suscripcion vencida y archiva el ciclo que termina.
// Va por separado del envio de correos a proposito: el estado es lo unico que
// miran los guards de sesion (`suscription_active` en #Config/express.js y en
// el middleware de la API), asi que la baja no puede depender de que responda
// el SMTP. Antes el `$set` de "Finalizado" vivia dentro del bloque que enviaba
// el mail.
const finalizeExpiredSuscriptions = async (now) => {

    const plan = await planExpiredSuscriptionsClosure(now);
    if ( !plan.length ) return 0;

    await UserModel.bulkWrite(
        plan.map(({ user, history }) => ({
            updateOne: {
                filter: { _id: user._id },
                update: { "$set": {
                    "suscription.status": "Finalizado",
                    "suscription_history": history,
                }},
            },
        })),
        { ordered: false },
    );

    console.log("[cron suscripciones] suscripciones finalizadas:", plan.length,
        "| ciclos archivados:", plan.filter((item) => item.archived).length);

    // Una entrada por usuario dado de baja: es la unica forma de explicar
    // despues por que alguien perdio el acceso un dia concreto sin que nadie
    // tocara nada. Sin req ni res porque no hay peticion detras, y con
    // `actor_type: 'system'` para que la fila no parezca obra de una persona.
    await logActivityMany(null, null, plan.map(({ user, archived }) => ({
        action: ACTIVITY_ACTIONS.SUBSCRIPTION_EXPIRED,
        actor_type: 'system',
        user_id: user._id,
        user_email: user.email,
        user_name: user.username ?? user.name,
        target_type: 'user',
        target_id: user._id,
        target_name: user.suscription?.name,
        metadata: { end_date: user.suscription?.end_date, cycle_archived: Boolean(archived) },
    })));

    return plan.length;
}

// Envia una notificacion por usuario y marca el flag solo si el envio salio
// bien: sendMailNotification resuelve false ante un error de SMTP en vez de
// lanzar, y marcar igual dejaba al usuario como notificado sin haber recibido
// nada. Si falla se reintenta en la corrida del dia siguiente.
const notifySuscriptors = async ({ suscriptors, subject, template, flag }) => {

    for ( const suscriptor of suscriptors ) {

        try {

            const sent = await sendMailNotification(
                {
                    from: MAIL_FROM,
                    subject,
                    email: suscriptor.email,
                    template, // template folder /views/mail
                },
                {
                    user: suscriptor.toObject(),
                    WEB_URL: process.env.WEB_URL,
                });

            if ( !sent ) {
                console.error("[cron suscripciones] no se pudo enviar", template, "a", suscriptor.email);
                continue;
            }

            await UserModel.updateOne({ _id: suscriptor._id }, { "$set": { [flag]: true } }).exec();

        } catch (error) {
            // Un usuario con datos inconsistentes (o una plantilla que no
            // compila) no puede abortar la cola: sin este try/catch el fallo
            // salia del for y se comia a todos los suscriptores restantes.
            console.error("[cron suscripciones] error notificando a", suscriptor?.email, error);
        }
    }
}

const runSuscriptionNotifications = async () => {

    const now = new Date();

    await finalizeExpiredSuscriptions(now);

    const renovationLimit = new Date(now.getTime() + (RENOVATION_WINDOW_DAYS * DAY_MS));

    // `$ne: true` y no `$exists: false`: el schema declara los dos flags con
    // `default: false`, asi que mongoose los persiste en el primer save() del
    // usuario y `$exists: false` dejaba fuera justamente a quien acababa de
    // comprar una suscripcion.
    const [ toRenovate, toExpire ] = await Promise.all([
        UserModel.find({
            "suscription.end_date": endDateFilter({ "$gt": now, "$lte": renovationLimit }),
            "notification_subscription_renovation": { "$ne": true },
        }).exec(),
        UserModel.find(pendingExpirationMailFilter(now)).exec(),
    ]);

    await notifySuscriptors({
        suscriptors: toRenovate,
        subject: 'Notificación de renovación de suscripción',
        template: 'email_suscription_renovation',
        flag: 'notification_subscription_renovation',
    });

    await notifySuscriptors({
        suscriptors: toExpire,
        subject: 'Suscripción finalizada en Eduteka',
        template: 'email_suscription_expired',
        flag: 'notification_subscription_expiration',
    });
}

// La tarea se agenda solo cuando alguien llama a esta funcion. Antes se
// registraba como efecto secundario del import y ningun modulo importaba el
// archivo, de modo que el cron nunca llego a ejecutarse.
const startSuscriptionCron = () => cron.schedule("0 9 * * *", async () => {

    try {
        await runSuscriptionNotifications();
    } catch (error) {
        // El callback es async: sin este catch cualquier fallo terminaba como
        // unhandled rejection y en silencio.
        console.error("[cron suscripciones] la corrida diaria fallo", error);
    }

},
{
    // Una corrida puede tardar (un correo por suscriptor, SMTP de por medio):
    // si se solapara con la siguiente se mandarian avisos duplicados.
    noOverlap: true,
    timezone: "America/Bogota",
});

export default startSuscriptionCron;
export {
    runSuscriptionNotifications,
    finalizeExpiredSuscriptions,
    planExpiredSuscriptionsClosure,
    expiredSuscriptionsFilter,
    pendingExpirationMailFilter,
};
