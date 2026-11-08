// Un solo dispositivo a la vez en el examen en curso (web o app, o dos navegadores).
//
// Port de eduteka/src/libs/exam_session.js (mismo algoritmo y constantes). Contrato §4.1.
//
// El bloqueo es un ARRENDAMIENTO (lease) guardado en la propia inscripcion, que es el
// intento vivo y lo comparten el monolito y la API:
//
//   usersimulacrums.exam_session = { id, client, claimed_at, last_seen_at }
//
//   - `id`   identifica al dispositivo ("<client>:<sid>").
//   - Quien abre el examen lo reclama; cada respuesta, el cierre y el latido (cada
//     EXAM_HEARTBEAT_SECONDS) lo renuevan.
//   - Si el titular deja de dar senales EXAM_SESSION_TTL_SECONDS, otro dispositivo puede
//     retomarlo. Es el MISMO intento: el cronometro no se reinicia.
//   - Reabrir desde el mismo dispositivo entra de inmediato: el id coincide.
//
// Las dos escrituras son atomicas (filtro + $set en una sola actualizacion): si dos
// dispositivos reclaman a la vez, gana uno.

export const EXAM_SESSION_TTL_SECONDS = 60;
export const EXAM_HEARTBEAT_SECONDS = 20;
export const EXAM_SESSION_HEADER = 'x-exam-session';

// Apps anteriores a este cambio no mandan la cabecera: comparten un sid fijo, que sigue separando web de app.
const LEGACY_SID = 'legacy';
const SID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const toTime = (value) => {
    if (!value) return null;
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
};

/** Identidad del dispositivo: separa los espacios de la web y de la app. */
export const sessionKey = (client, sid) => `${client}:${sid}`;

/**
 * Dispositivo que hace la peticion: `{ key, client }`. `client` lo resuelve el middleware `client.js`
 * ('web' | 'app'); `sid` llega en `X-Exam-Session` (un UUID). Falta o es invalido => 'legacy'.
 */
export const deviceOf = (req) => {
    const client = req.client === 'web' ? 'web' : 'app';
    const raw = String(req.get?.(EXAM_SESSION_HEADER) ?? '').trim();
    const sid = SID_PATTERN.test(raw) ? raw : LEGACY_SID;
    return { key: sessionKey(client, sid), client };
};

/** El titular sigue vivo: dio senales dentro de la ventana de arrendamiento. */
export const leaseActive = (session, now = new Date()) => {
    const seen = toTime(session?.last_seen_at);
    return Boolean(session?.id) && seen !== null && seen > now.getTime() - EXAM_SESSION_TTL_SECONDS * 1000;
};

/** Datos del titular para mostrar al que queda fuera. */
export const holderInfo = (session, now = new Date()) => {
    const seen = toTime(session?.last_seen_at) ?? now.getTime();
    const remaining = Math.ceil((seen + EXAM_SESSION_TTL_SECONDS * 1000 - now.getTime()) / 1000);
    return {
        client: session?.client === 'app' ? 'app' : 'web',
        last_seen_at: new Date(seen).toISOString(),
        retry_after_seconds: Math.max(1, remaining),
    };
};

const notHeld = (now) => [
    { exam_session: { $exists: false } },
    { 'exam_session.id': null },
    { 'exam_session.last_seen_at': { $lt: new Date(now.getTime() - EXAM_SESSION_TTL_SECONDS * 1000) } },
];

/**
 * Reclama o renueva el bloqueo del intento para `key`.
 *
 * @param model        modelo de Mongoose de usersimulacrums (inyectado)
 * @param enrollmentId _id de la inscripcion
 * @returns {Promise<{ ok: true, took_over: boolean, closed?: true } | { ok: false, holder: object }>}
 */
export const claimExamSession = async (model, enrollmentId, key, client, now = new Date()) => {
    // 1) Renovar: ya soy el titular.
    const touched = await model.updateOne(
        { _id: enrollmentId, finished: { $ne: true }, 'exam_session.id': key },
        { $set: { 'exam_session.last_seen_at': now } },
    ).exec();
    if (touched.matchedCount > 0) return { ok: true, took_over: false };

    // 2) Tomarlo: nadie lo tiene, o el titular dejo de dar senales.
    const taken = await model.updateOne(
        { _id: enrollmentId, finished: { $ne: true }, $or: notHeld(now) },
        { $set: { exam_session: { id: key, client, claimed_at: now, last_seen_at: now } } },
    ).exec();
    if (taken.matchedCount > 0) return { ok: true, took_over: true };

    // 3) Otro dispositivo lo tiene (o el intento ya se cerro).
    const current = await model.findOne({ _id: enrollmentId }, { exam_session: 1, finished: 1 }).lean().exec();
    if (!current || current.finished === true) return { ok: true, took_over: false, closed: true };
    // Dos reclamos simultaneos del MISMO dispositivo (doble toque, reintento de red): el otro ya lo tomo para
    // nosotros, entre el paso 1 y el 2. No es otro titular. (Divergencia deliberada del monolito: portarla alla.)
    if (current.exam_session?.id === key) return { ok: true, took_over: false };
    return { ok: false, holder: holderInfo(current.exam_session, now) };
};
