import ActivityLogModel from '#Models/activity_log_model.js';
import { ACTION_CATEGORY } from '#Libs/activity_actions.js';

// Los user-agent reales rondan los 120-250 caracteres, pero nada impide que
// llegue una cabecera de kilobytes. Se corta para no engordar la coleccion.
// Mismo criterio y mismo tope que #Libs/download_log.js.
const MAX_USER_AGENT = 500;

// `target_name` es un snapshot para poder leer la fila del panel, no una copia
// del recurso. Un titulo de examen entra de sobra; el enunciado de una pregunta
// puede traer parrafos enteros con html, y sin tope el log pesaria mas que el
// banco de preguntas.
const MAX_TARGET_NAME = 300;

/**
 * Arma el documento a partir de la request y de lo que pase el llamador.
 *
 * `data` gana siempre sobre `res.locals`, y eso no es un detalle: en el login la
 * cookie recien se emitio, asi que `res.locals.user_session` todavia es la
 * sesion anonima de esta request. Si el evento no pasara el usuario explicito,
 * `auth.login` quedaria registrado sin saber quien entro.
 */
const buildEntry = (req, res, data) => {
    const session = res?.locals?.user_session;

    const user_id = data.user_id ?? res?.locals?.user_id ?? session?._id ?? null;
    const user_rol = data.user_rol ?? session?.rol ?? null;

    // A diferencia de logDownload, aqui no se descarta el evento cuando falta el
    // usuario: el favorito anonimo y el login fallido no tienen uno, y son
    // precisamente dos de los eventos que interesa registrar.
    let actor_type = data.actor_type;
    if (!actor_type) {
        if (!user_id) actor_type = 'anonymous';
        else if (user_rol === 'Administrador') actor_type = 'admin';
        else actor_type = 'user';
    }

    return {
        ...data,
        user_id,
        user_rol,
        actor_type,
        target_name: data.target_name ? String(data.target_name).slice(0, MAX_TARGET_NAME) : null,
        // La categoria nunca la pasa el llamador: sale del catalogo.
        category: ACTION_CATEGORY[data.action],
        user_email: data.user_email ?? session?.email ?? null,
        user_name: data.user_name ?? session?.name ?? session?.username ?? null,
        user_account_type: data.user_account_type ?? session?.account_type ?? null,
        ip: req?.ip ?? null,
        user_agent: (req?.get?.('user-agent') ?? '').slice(0, MAX_USER_AGENT) || null,
    };
};

/**
 * Registra una accion de usuario.
 *
 * Se llama DESPUES de que la accion haya tenido exito y SIN `await`: el registro
 * es auditoria y no puede retrasar la respuesta ni, sobre todo, romper la accion
 * que audita. Por eso la promesa se traga cualquier error y solo lo deja en
 * consola — igual que #Libs/download_log.js.
 *
 *   void logActivity(req, res, {
 *     action: ACTIVITY_ACTIONS.EXAM_FAVORITED,
 *     target_type: 'exam', target_id: exam._id, target_slug: exam.slug,
 *     target_name: exam.name, metadata: { favorites_count: 12 },
 *   });
 *
 * La identidad sale de `res.locals` — en este proyecto no existe `req.user`, la
 * sesion vive ahi (ver #Libs/auth.js) — y se puede sobreescribir por `data`.
 */
const logActivity = async (req, res, data) => {
    try {
        if (!data?.action) return;
        await ActivityLogModel.create(buildEntry(req, res, data));
    } catch (error) {
        // Una accion legitima no puede fallar porque fallo su log.
        console.error('No se pudo registrar la actividad:', error);
    }
};

// Tope de entradas por lote. Una aplicacion masiva de sugerencias de IA puede
// venir con cientos de preguntas; a partir de aqui se registran las primeras y
// el total real queda en `batch_size` de cada entrada.
const MAX_BATCH = 200;

/**
 * Registra varias acciones del mismo actor en una sola escritura.
 *
 * Para las operaciones en bloque del panel (aplicar sugerencias de IA a N
 * preguntas, aplicar temas a N preguntas). Se prefiere esto a un `logActivity`
 * por elemento porque conserva una fila por recurso —que es lo que permite
 * preguntar despues "quien toco esta pregunta"— sin pagar N inserciones.
 *
 * Se llama igual que logActivity: sin `await` y sin poder romper al llamador.
 */
const logActivityMany = async (req, res, dataList) => {
    try {
        const entries = (dataList ?? [])
            .filter((data) => data?.action)
            .slice(0, MAX_BATCH)
            .map((data) => buildEntry(req, res, data));

        if (entries.length === 0) return;

        // `ordered: false` para que una entrada invalida no cancele el resto.
        await ActivityLogModel.insertMany(entries, { ordered: false });
    } catch (error) {
        console.error('No se pudo registrar el lote de actividad:', error);
    }
};

/**
 * Variante para procesos sin request detras (el cron de suscripciones, los
 * scripts de mantenimiento). Deja `actor_type: 'system'` y no intenta resolver
 * ninguna sesion.
 */
const logSystemActivity = async (data) => {
    try {
        if (!data?.action) return;
        await ActivityLogModel.create(buildEntry(null, null, { ...data, actor_type: 'system' }));
    } catch (error) {
        console.error('No se pudo registrar la actividad del sistema:', error);
    }
};

export { logActivity, logActivityMany, logSystemActivity };
export default logActivity;
