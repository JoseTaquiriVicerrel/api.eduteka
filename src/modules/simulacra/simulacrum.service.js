import { randomUUID } from 'node:crypto';
import SimulacrumModel from '#Models/simulacrum_model.js';
import UserModel from '#Models/user_model.js';
import UserSimulacrumModel from '#Models/user_simulacrum_model.js';
import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { canSeeSolutions, isPremium } from '#Libs/capabilities.js';
import { deleteCapture, saveCapture } from '#Libs/capture_storage.js';
import { del, setNX } from '#Libs/kv.js';
import { skipOf } from '#Libs/paginate.js';
import { getSimulacrumAreaOptions } from '#Libs/simulacrum_areas.js';
import { sendMail } from '#Libs/mailer.js';
import { absoluteUrl, absolutizeHtml } from '#Libs/urls.js';
import { verifyVoucher } from '#Modules/payments/voucher.verify.js';
import { invalidateProgress } from '#Modules/progress/progress.cache.js';
import { archiveAttempt, attemptFilter, listAttempts, startNewAttempt } from './simulacrum.attempts.js';
import { gradeAttempt } from './simulacrum.grading.js';
import { loadQuestionSet, questionIdSet } from './simulacrum.questions.js';
import {
    attemptExpired, attemptNumberOf, enrollmentState, freezesOfficialScore, isRetryInProgress,
    retryBlockedReason, simulacrumStatus, startWindowViolation,
} from './simulacrum.state.js';

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iso = (value) => (value ? new Date(value).toISOString() : null);
const toTime = (value) => (value ? new Date(value).getTime() : null);

// --- Carga y serializacion --------------------------------------------------

const VISIBLE = { verified: true, state: { $ne: false } };

// Ficha SIN las preguntas (`general_items` y `areas[K].questions` pesan mucho): de
// cada area solo se queda lo que se muestra y cuantas preguntas tiene.
const LIGHT_PIPELINE = [
    {
        $project: {
            title: 1, slug: 1, description: 1, image_post: 1, institution: 1, price: 1, duration: 1, automatic: 1,
            finished: 1, general: 1, verified: 1, state: 1, start_date: 1, end_date: 1, date_program: 1, for_register: 1,
            public_results: 1, score_correct: 1, score_incorrect: 1, score_not_answered: 1, prospect: 1, created_at: 1,
            general_count: { $size: { $ifNull: ['$general_items', []] } },
            areas: {
                $arrayToObject: {
                    $map: {
                        input: { $objectToArray: { $ifNull: ['$areas', {}] } },
                        as: 'area',
                        in: {
                            k: '$$area.k',
                            v: {
                                description: '$$area.v.description',
                                title: '$$area.v.title',
                                careers: { $ifNull: ['$$area.v.careers', []] },
                                questions_count: { $size: { $ifNull: ['$$area.v.questions', []] } },
                            },
                        },
                    },
                },
            },
        },
    },
];

const findLight = async (slug, { requireVisible = true } = {}) => {
    const [simulacrum] = await SimulacrumModel.aggregate([
        { $match: { slug, ...(requireVisible ? VISIBLE : {}) } },
        ...LIGHT_PIPELINE,
    ]).exec();
    if (!simulacrum) throw ApiError.notFound('No encontramos ese simulacro.');
    return simulacrum;
};

const serializeSummary = (simulacrum, enrollment, now) => ({
    id: simulacrum._id,
    title: simulacrum.title ?? null,
    slug: simulacrum.slug,
    description: simulacrum.description ?? null,
    image: simulacrum.image_post ? absoluteUrl(simulacrum.image_post) : null,
    institution: simulacrum.institution
        ? { id: simulacrum.institution.id ?? null, name: simulacrum.institution.name ?? null, abrev: simulacrum.institution.abrev ?? null }
        : null,
    price: simulacrum.price ?? 0,
    duration_minutes: simulacrum.duration ?? null,
    automatic: simulacrum.automatic === true,
    status: simulacrumStatus(simulacrum, now),
    start_date: iso(simulacrum.start_date),
    end_date: iso(simulacrum.end_date),
    scheduled_for: iso(simulacrum.date_program),
    for_register: simulacrum.for_register !== false,
    public_results: simulacrum.public_results !== false,
    enrolled: enrollment === undefined ? undefined : Boolean(enrollment),
});

const PENDING_REASON = 'Pendiente de verificación';

const serializeEnrollment = (simulacrum, enrollment, now) => {
    const blocked = retryBlockedReason(enrollment, simulacrum);
    return {
        id: enrollment._id,
        verified: enrollment.state === true,
        // `status_reason` guarda el motivo interno de la revision manual (lo lee el panel del
        // administrador, igual que en la web): al postulante solo se le dice que esta pendiente.
        status_reason: enrollment.state === true ? null : PENDING_REASON,
        area: enrollment.area ?? null,
        career: enrollment.career ?? null,
        amount_paid: enrollment.amount_paid ?? 0,
        attempt_number: attemptNumberOf(enrollment),
        finished: enrollment.finished === true,
        start_exam: iso(enrollment.start_exam),
        end_exam: iso(enrollment.end_exam),
        state: enrollmentState(simulacrum, enrollment, now),
        can_retry: blocked === null,
        retry_blocked_reason: blocked,
    };
};

// --- Listado y ficha --------------------------------------------------------

const statusClauses = (status, now) => {
    const open = { $or: [{ end_date: null }, { end_date: { $gte: now } }] };
    switch (status) {
        case 'finished':
            return [{ $or: [{ finished: true }, { automatic: true, end_date: { $lt: now } }] }];
        case 'upcoming':
            return [{ finished: { $ne: true } }, { automatic: true }, { $or: [{ start_date: null }, { start_date: { $gt: now } }] }, open];
        case 'live':
            return [
                { finished: { $ne: true } },
                { $or: [{ automatic: { $ne: true } }, { $and: [{ automatic: true }, { start_date: { $lte: now } }, open] }] },
            ];
        default:
            return null;
    }
};

export const listSimulacra = async ({ institution, q, status, page, limit, user }) => {
    const now = new Date();
    const filter = { ...VISIBLE };

    if (institution) filter['institution.id'] = institution;

    const search = String(q ?? '').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (search) filter.title = new RegExp(escapeRegex(search), 'i');

    const clauses = statusClauses(status, now);
    if (clauses) filter.$and = clauses;

    const [items, total] = await Promise.all([
        SimulacrumModel.find(filter, {
            title: 1, slug: 1, description: 1, image_post: 1, institution: 1, price: 1, duration: 1, automatic: 1, finished: 1,
            start_date: 1, end_date: 1, date_program: 1, for_register: 1, public_results: 1,
        }).sort({ created_at: -1, _id: 1 }).skip(skipOf({ page, limit })).limit(limit).lean().exec(),
        SimulacrumModel.countDocuments(filter).exec(),
    ]);

    let enrolledIds = null;
    if (user && items.length) {
        const enrollments = await UserSimulacrumModel
            .find({ user_id: user._id, simulacrum_id: { $in: items.map((item) => item._id) } }, { simulacrum_id: 1 })
            .lean()
            .exec();
        enrolledIds = new Set(enrollments.map((row) => row.simulacrum_id));
    }

    return {
        total,
        items: items.map((item) => serializeSummary(item, enrolledIds ? enrolledIds.has(item._id) : undefined, now)),
    };
};

export const getSimulacrumDetail = async ({ slug, user }) => {
    const now = new Date();
    const simulacrum = await findLight(slug);
    const enrollment = user
        ? await UserSimulacrumModel.findOne({ user_id: user._id, simulacrum_id: simulacrum._id }).lean().exec()
        : null;

    const options = getSimulacrumAreaOptions(simulacrum);

    return {
        ...serializeSummary(simulacrum, user ? enrollment : undefined, now),
        ...options,
        areas: Object.entries(simulacrum.areas ?? {}).map(([key, area]) => ({
            key,
            title: area.title ?? null,
            description: area.description ?? null,
            careers: area.careers ?? [],
            questions_count: area.questions_count ?? 0,
        })),
        scoring: {
            correct: simulacrum.score_correct ?? null,
            incorrect: simulacrum.score_incorrect ?? null,
            not_answered: simulacrum.score_not_answered ?? null,
        },
        enrollment: enrollment ? serializeEnrollment(simulacrum, enrollment, now) : null,
        server_time: now.toISOString(),
    };
};

// --- Inscripcion ------------------------------------------------------------

export const enroll = async ({ user, slug, body, capture }) => {
    const simulacrum = await SimulacrumModel.findOne({ slug, ...VISIBLE }).lean().exec();
    if (!simulacrum) throw ApiError.notFound('No encontramos ese simulacro.');
    if (simulacrum.for_register !== true) throw ApiError.forbidden('Ha finalizado el plazo de inscripción a este simulacro.');

    const price = Number(simulacrum.price) || 0;
    if (price > 0 && !settings.app.paymentsEnabled) {
        throw ApiError.forbidden('Las inscripciones de pago no están disponibles por ahora.');
    }

    const { ask_area: askArea, ask_career: askCareer } = getSimulacrumAreaOptions(simulacrum);
    const areaKeys = Object.keys(simulacrum.areas ?? {});

    let area;
    if (askArea) {
        // Un area que no esta entre las del simulacro no falla al inscribirse sino despues,
        // al calificar, con la inscripcion ya guardada y el postulante sin nota.
        if (!body.area || !areaKeys.includes(body.area)) {
            throw ApiError.validation([{ field: 'area', message: 'Selecciona un área profesional válida.' }]);
        }
        area = body.area;
    } else {
        // Sin eleccion posible se fija la unica que hay (es la llave con la que se leen y califican las preguntas).
        area = areaKeys[0] ?? null;
    }

    let career = null;
    if (askCareer) {
        const careers = simulacrum.areas?.[area]?.careers ?? [];
        if (careers.length > 0 && !careers.includes(body.career)) {
            throw ApiError.validation([{ field: 'career', message: 'Selecciona una carrera válida.' }]);
        }
        career = body.career ?? null;
    }

    if (price > 0 && !capture) {
        throw ApiError.validation([{ field: 'screenshot', message: 'Adjunta el comprobante de pago.' }]);
    }

    // Una inscripcion por usuario y simulacro. Con datos validos, un segundo toque espera;
    // el bloqueo se toma justo antes de escribir y se libera siempre, para que corregir un
    // dato y reintentar no choque con el intento anterior.
    const lockKey = `enroll-lock:${user._id}:${simulacrum._id}`;
    // Cubre la lectura del comprobante con IA (PAYMENT_AI_TIMEOUT_MS).
    if (!(await setNX(lockKey, 90))) throw ApiError.conflict('Tu inscripción aún se está procesando.');

    try {
        return await createEnrollment({ user, simulacrum, body, capture, price, area, career });
    } finally {
        await del(lockKey);
    }
};

const createEnrollment = async ({ user, simulacrum, body, capture, price, area, career }) => {
    if (await UserSimulacrumModel.exists({ user_id: user._id, simulacrum_id: simulacrum._id })) {
        throw ApiError.conflict('Ya estás inscrito en este simulacro.');
    }

    const enrollment = {
        _id: randomUUID(),
        user_id: user._id,
        simulacrum_id: simulacrum._id,
        fullname: body.fullname,
        dni: body.dni,
        area,
        career,
        // El precio vigente se congela: si luego cambia, los ingresos ya reportados no se mueven.
        amount_paid: price,
    };

    if (price <= 0) {
        enrollment.state = true;
        await UserSimulacrumModel.create(enrollment);
    } else {
        // Como en la web, el comprobante pasa primero por la IA (#Modules/payments/voucher.verify.js):
        // con numero de operacion, monto y fecha correctos la inscripcion queda verificada; si
        // no, pendiente con el motivo hasta que un administrador la apruebe en el panel.
        const verification = await verifyVoucher(capture, price);
        try {
            enrollment.state = verification.approved;
            if (!verification.approved) enrollment.status_reason = verification.reason;
            if (verification.aiData) enrollment.ai_analysis = verification.aiData;
            enrollment.screenshot = await saveCapture(capture);
            try {
                await UserSimulacrumModel.create(enrollment);
            } catch (error) {
                await deleteCapture(enrollment.screenshot);
                throw error;
            }
        } finally {
            await verification.release();
        }
    }

    await UserModel.updateOne({ _id: user._id }, { $set: { fullname: body.fullname } }).exec();

    if (price > 0) {
        const verified = enrollment.state === true;
        void sendMail({
            to: user.email,
            subject: verified ? 'Inscripción confirmada' : 'Recibimos tu inscripción',
            template: 'api_simulacrum_enrolled',
            data: { username: user.username, title: simulacrum.title, verified },
        });
        if (settings.adminEmail) {
            void sendMail({
                to: settings.adminEmail,
                subject: verified ? 'Inscripción verificada automáticamente' : 'Nueva inscripción con comprobante',
                template: 'api_simulacrum_payment_review',
                data: {
                    title: simulacrum.title, fullname: body.fullname, email: user.email, price, enrollment_id: enrollment._id,
                    verified, reason: enrollment.status_reason ?? null,
                },
            });
        }
    }

    return serializeEnrollment(simulacrum, enrollment, new Date());
};

// --- Calificacion -----------------------------------------------------------

/**
 * Cierra y califica el intento vivo. El cierre es UN findOneAndUpdate condicionado a
 * `finished != true`: si el boton "Finalizar" y la calificacion perezosa de /resultados
 * coinciden, solo uno escribe.
 *
 * @returns {Promise<{ graded: boolean, enrollment: object }>}
 */
const gradeAndClose = async ({ simulacrum, enrollment, finishedAt }) => {
    const { prospect, items } = await loadQuestionSet(simulacrum, enrollment.area);
    const fields = gradeAttempt({ simulacrum, prospect, enrollment, items });

    const end = toTime(enrollment.end_exam);
    // Nunca se cuenta tiempo ni se marca cierre pasado el limite del intento.
    const finished = end !== null && finishedAt.getTime() > end ? new Date(end) : finishedAt;
    const start = toTime(enrollment.start_exam);
    const time = start === null ? 0 : Math.max(0, Math.round((finished.getTime() - start) / 1000));

    const set = { ...fields, time, finished: true, exam_finished: finished };
    const update = { $set: set };
    if (fields.score_conversion === undefined) update.$unset = { score_conversion: '' };

    // El ranking publico se congela en el primer intento.
    if (freezesOfficialScore(enrollment)) {
        set.official_score = fields.score;
        if (fields.score_conversion !== undefined) set.official_score_conversion = fields.score_conversion;
    }

    const updated = await UserSimulacrumModel.findOneAndUpdate(
        { _id: enrollment._id, finished: { $ne: true }, attempt_number: attemptFilter(attemptNumberOf(enrollment)) },
        update,
        { new: true },
    ).lean().exec();

    if (!updated) {
        return { graded: false, enrollment: await UserSimulacrumModel.findById(enrollment._id).lean().exec() };
    }

    await archiveAttempt(updated);
    await invalidateProgress(updated.user_id);
    return { graded: true, enrollment: updated };
};

/** Fila heredada: terminada, pero de antes de que se guardara el puntaje. Se completa sin reabrirla. */
const backfillScore = async ({ simulacrum, enrollment }) => {
    const { prospect, items } = await loadQuestionSet(simulacrum, enrollment.area);
    const fields = gradeAttempt({ simulacrum, prospect, enrollment, items });
    const set = { ...fields };
    if (freezesOfficialScore(enrollment)) {
        set.official_score = fields.score;
        if (fields.score_conversion !== undefined) set.official_score_conversion = fields.score_conversion;
    }

    const updated = await UserSimulacrumModel.findOneAndUpdate(
        { _id: enrollment._id, finished: true, score: null },
        { $set: set },
        { new: true },
    ).lean().exec();
    if (updated) await archiveAttempt(updated);
    return updated ?? enrollment;
};

const ownEnrollment = async (attemptId, user) => {
    const enrollment = await UserSimulacrumModel.findOne({ _id: attemptId, user_id: user._id }).lean().exec();
    if (!enrollment) throw ApiError.notFound('No encontramos ese intento.');
    return enrollment;
};

const loadFull = async (simulacrumId) => {
    const simulacrum = await SimulacrumModel.findById(simulacrumId).lean().exec();
    if (!simulacrum) throw ApiError.notFound('No encontramos ese simulacro.');
    return simulacrum;
};

const toClientItems = (items) => {
    let number = 0;
    return items.map((item) => {
        if (item.kind === 'reading') return { kind: 'reading', id: item.id, title: item.title, text: absolutizeHtml(item.text), area: item.area };
        number += 1;
        return {
            kind: 'question',
            id: item.id,
            n: number,
            area: item.area,
            question: absolutizeHtml(item.question),
            options: item.options.map((option) => ({ key: option.key, text: absolutizeHtml(option.text) })),
        };
    });
};

const savedAnswers = (enrollment) =>
    Object.fromEntries(Object.entries(enrollment.answers ?? {}).map(([id, answer]) => [id, answer?.option ?? null]));

const attemptSummary = (enrollment) => {
    const correct = enrollment.questions_correct ?? 0;
    const incorrect = enrollment.questions_incorrect ?? 0;
    const notAnswered = enrollment.questions_not_answered ?? 0;
    return {
        attempt_id: enrollment._id,
        attempt_number: attemptNumberOf(enrollment),
        finished_at: iso(enrollment.exam_finished),
        time: enrollment.time ?? 0,
        total: correct + incorrect + notAnswered,
        correct,
        incorrect,
        not_answered: notAnswered,
        score: enrollment.score ?? null,
        score_conversion: enrollment.score_conversion ?? null,
    };
};

// --- Rendir: iniciar, autoguardar, finalizar --------------------------------

export const startAttempt = async ({ user, slug }) => {
    const now = new Date();
    const simulacrum = await SimulacrumModel.findOne({ slug }).lean().exec();
    if (!simulacrum) throw ApiError.notFound('No encontramos ese simulacro.');

    let enrollment = await UserSimulacrumModel.findOne({ user_id: user._id, simulacrum_id: simulacrum._id }).lean().exec();
    if (!enrollment) throw ApiError.notFound('No estás inscrito en este simulacro.');
    if (enrollment.state !== true) throw ApiError.forbidden('Tu inscripción todavía no ha sido verificada.');
    if (enrollment.finished === true) throw ApiError.conflict('Ya terminaste este intento.');

    const retrying = isRetryInProgress(enrollment);
    // Un simulacro cerrado ya no admite intentos oficiales; un reintento ya abierto si.
    if (simulacrum.finished === true && !retrying) throw ApiError.forbidden('El simulacro ya cerró.');
    if (!retrying) {
        const violation = startWindowViolation(simulacrum, now);
        if (violation) throw ApiError.forbidden(violation);
    }

    // Se le acabo el tiempo y nadie lo cerro: se califica con lo guardado y se avisa.
    if (attemptExpired(enrollment, now)) {
        await gradeAndClose({ simulacrum, enrollment, finishedAt: now });
        throw ApiError.conflict('El tiempo de este intento terminó; ya fue calificado con tus respuestas guardadas.');
    }

    if (!enrollment.start_exam) {
        const minutes = Number(simulacrum.duration);
        if (!(minutes > 0)) throw ApiError.conflict('Este simulacro no tiene una duración configurada.');

        // El cronometro lo fija el servidor, una sola vez: de dos aperturas simultaneas gana una.
        const started = await UserSimulacrumModel.findOneAndUpdate(
            { _id: enrollment._id, finished: { $ne: true }, state: true, start_exam: null, attempt_number: attemptFilter(attemptNumberOf(enrollment)) },
            { $set: { start_exam: now, end_exam: new Date(now.getTime() + minutes * 60_000) } },
            { new: true },
        ).lean().exec();
        enrollment = started ?? (await UserSimulacrumModel.findById(enrollment._id).lean().exec());
    }

    const { items } = await loadQuestionSet(simulacrum, enrollment.area);
    if (!items.some((item) => item.kind === 'question')) throw ApiError.conflict('El área del simulacro no tiene preguntas.');

    return {
        attempt_id: enrollment._id,
        attempt_number: attemptNumberOf(enrollment),
        simulacrum: { id: simulacrum._id, slug: simulacrum.slug, title: simulacrum.title ?? null },
        area: enrollment.area ?? null,
        // La app muestra end_exam - server_time (corregido con el reloj del servidor).
        start_exam: iso(enrollment.start_exam),
        end_exam: iso(enrollment.end_exam),
        server_time: new Date().toISOString(),
        total_questions: items.filter((item) => item.kind === 'question').length,
        answers: savedAnswers(enrollment),
        items: toClientItems(items),
    };
};

// Aplica un mapa de respuestas al intento vivo escribiendo SOLO las claves que cambian
// (nunca el mapa completo): una app vieja con el intento anterior en memoria no puede
// volcarlo encima del nuevo.
const writeAnswers = async ({ simulacrum, enrollment, answers, attemptNumber }) => {
    const ids = Object.keys(answers);
    if (ids.length === 0) return 0;

    if (attemptNumber !== undefined && attemptNumber !== attemptNumberOf(enrollment)) {
        throw ApiError.conflict('Este intento ya no está activo.');
    }

    // Solo ids de preguntas de ESTE intento (y sin los caracteres que cambiarian la ruta `answers.<id>`).
    const valid = await questionIdSet(simulacrum, enrollment.area);
    const unknown = ids.filter((id) => !valid.has(id) || /[.$]/.test(id));
    if (unknown.length) {
        throw ApiError.validation(unknown.map((id) => ({ field: `answers.${id}`, message: 'La pregunta no pertenece a este intento.' })));
    }

    const now = new Date();
    const set = {};
    const unset = {};
    for (const [id, option] of Object.entries(answers)) {
        if (option === null) unset[`answers.${id}`] = '';
        else set[`answers.${id}`] = { option: option.toUpperCase(), question_id: id, date: now };
    }
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;

    const written = await UserSimulacrumModel.updateOne(
        { _id: enrollment._id, finished: { $ne: true }, attempt_number: attemptFilter(attemptNumberOf(enrollment)) },
        update,
    ).exec();
    if (written.matchedCount === 0) throw ApiError.conflict('Este intento ya no está activo.');
    return ids.length;
};

// Ids de las preguntas sin cargar enunciados: solo `id` e `itype` de cada elemento.
const lightQuestionDoc = (simulacrumId, area) => SimulacrumModel.findById(simulacrumId, {
    general: 1, prospect: 1, 'general_items.id': 1, 'general_items.itype': 1,
    ...(area && /^[^.$]+$/.test(area) ? { [`areas.${area}.questions.id`]: 1, [`areas.${area}.questions.itype`]: 1 } : {}),
}).lean().exec();

const assertAcceptsAnswers = (enrollment, now, { graceSeconds = settings.limits.simulacrumAnswerGraceSeconds } = {}) => {
    if (enrollment.finished === true) throw ApiError.conflict('Este intento ya terminó.');
    if (!enrollment.start_exam) throw ApiError.conflict('Todavía no iniciaste este intento.');
    const end = toTime(enrollment.end_exam);
    if (end !== null && now.getTime() > end + graceSeconds * 1000) {
        throw ApiError.conflict('El tiempo de este intento terminó. Finalízalo para ver tu resultado.');
    }
};

export const saveAnswers = async ({ user, attemptId, answers, attemptNumber }) => {
    const enrollment = await ownEnrollment(attemptId, user);
    assertAcceptsAnswers(enrollment, new Date());

    const simulacrum = await lightQuestionDoc(enrollment.simulacrum_id, enrollment.area);
    if (!simulacrum) throw ApiError.notFound('No encontramos ese simulacro.');

    const saved = await writeAnswers({ simulacrum, enrollment, answers, attemptNumber });
    return { saved, server_time: new Date().toISOString() };
};

export const finishAttempt = async ({ user, attemptId, answers, attemptNumber }) => {
    const now = new Date();
    let enrollment = await ownEnrollment(attemptId, user);

    if (enrollment.finished === true) throw ApiError.conflict('Ya finalizaste este intento.');
    if (!enrollment.start_exam) throw ApiError.conflict('Todavía no iniciaste este intento.');

    // Respuestas de ultima hora (dentro de la holgura). Pasado el limite, se corrige con lo guardado.
    if (answers && Object.keys(answers).length > 0) {
        const light = await lightQuestionDoc(enrollment.simulacrum_id, enrollment.area);
        const end = toTime(enrollment.end_exam);
        const open = end === null || now.getTime() <= end + settings.limits.simulacrumAnswerGraceSeconds * 1000;
        if (open && light) {
            await writeAnswers({ simulacrum: light, enrollment, answers, attemptNumber });
            enrollment = await UserSimulacrumModel.findById(enrollment._id).lean().exec();
        }
    } else if (attemptNumber !== undefined && attemptNumber !== attemptNumberOf(enrollment)) {
        throw ApiError.conflict('Este intento ya no está activo.');
    }

    const simulacrum = await loadFull(enrollment.simulacrum_id);
    const { graded, enrollment: closed } = await gradeAndClose({ simulacrum, enrollment, finishedAt: now });
    if (!graded) throw ApiError.conflict('Ya finalizaste este intento.');

    return { ...attemptSummary(closed), simulacrum_slug: simulacrum.slug };
};

// --- Resultados -------------------------------------------------------------

const RANKING_TOP = 20;

// Posicion y percentil con el puntaje congelado del primer intento, el mismo criterio
// para todos hayan reintentado o no. Rank de competicion: dos empates en 1 -> el siguiente es 3.
const buildRanking = async ({ simulacrum, enrollment, visible }) => {
    if (!visible) return { visible: false };

    const rows = await UserSimulacrumModel.find(
        { simulacrum_id: simulacrum._id, finished: true },
        { user_id: 1, fullname: 1, area: 1, career: 1, score: 1, official_score: 1, score_conversion: 1, official_score_conversion: 1, attempt_number: 1 },
    ).lean().exec();

    const scored = rows
        .map((row) => ({
            id: row._id,
            user_id: row.user_id,
            fullname: row.fullname ?? null,
            area: row.area ?? null,
            career: row.career ?? null,
            score: row.official_score ?? row.score,
            score_conversion: row.official_score_conversion ?? row.score_conversion ?? null,
            retried: (row.attempt_number ?? 1) > 1,
        }))
        .filter((row) => Number.isFinite(row.score))
        .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

    const total = scored.length;
    const rankOf = (score) => scored.findIndex((row) => row.score === score) + 1;
    const mine = enrollment ? scored.find((row) => row.id === enrollment._id) : null;
    const below = mine ? scored.filter((row) => row.score < mine.score).length : 0;

    return {
        visible: true,
        total_participants: total,
        has_retries: scored.some((row) => row.retried),
        me: mine
            ? { rank: rankOf(mine.score), percentile: total > 0 ? Math.round((below / total) * 1000) / 10 : null, score: mine.score, score_conversion: mine.score_conversion }
            : null,
        top: scored.slice(0, RANKING_TOP).map((row) => ({
            rank: rankOf(row.score),
            fullname: row.fullname,
            area: row.area,
            career: row.career,
            score: row.score,
            score_conversion: row.score_conversion,
            is_me: enrollment ? row.id === enrollment._id : false,
        })),
    };
};

export const getResults = async ({ user, slug }) => {
    const now = new Date();
    const simulacrum = await findLight(slug);
    let enrollment = await UserSimulacrumModel.findOne({ user_id: user._id, simulacrum_id: simulacrum._id }).lean().exec();

    const publicResults = simulacrum.public_results !== false;
    if (!enrollment && !publicResults) {
        throw ApiError.notFound('Los resultados de este simulacro son solo para sus participantes.');
    }

    if (enrollment) {
        // Calificacion perezosa: se acabo el tiempo y nadie cerro el intento. Se mira el reloj, no la
        // ausencia de nota (un reintento recien abierto tampoco la tiene y no debe cerrarse con cero).
        if (attemptExpired(enrollment, now)) {
            const full = await loadFull(simulacrum._id);
            enrollment = (await gradeAndClose({ simulacrum: full, enrollment, finishedAt: now })).enrollment;
        } else if (enrollment.finished === true && (enrollment.score === undefined || enrollment.score === null)) {
            enrollment = await backfillScore({ simulacrum: await loadFull(simulacrum._id), enrollment });
        }
    }

    // La tabla es publica si el simulacro lo es; si no, se publica al cerrarlo (solo para participantes).
    const rankingVisible = publicResults || (Boolean(enrollment) && simulacrum.finished === true);
    const [history, ranking] = await Promise.all([
        listAttempts(enrollment),
        buildRanking({ simulacrum, enrollment, visible: rankingVisible }),
    ]);

    const blocked = retryBlockedReason(enrollment, simulacrum);
    const finished = enrollment?.finished === true;

    return {
        simulacrum: { id: simulacrum._id, slug: simulacrum.slug, title: simulacrum.title ?? null, status: simulacrumStatus(simulacrum, now) },
        enrolled: Boolean(enrollment),
        // El resultado propio solo existe con el intento cerrado.
        attempt: finished ? attemptSummary(enrollment) : null,
        by_area: finished
            ? Object.entries(enrollment.results ?? {}).map(([area, row]) => ({
                area,
                total: row.questions_count ?? 0,
                correct: row.questions_correct ?? 0,
                incorrect: row.questions_incorrect ?? 0,
                not_answered: row.questions_not_answered ?? 0,
                score: row.score ?? null,
            }))
            : [],
        attempts: history.map((attempt) => ({
            attempt_number: attempt.attempt_number,
            is_current: attempt.is_current,
            // El primero es el que cuenta para el ranking publico.
            is_official: attempt.attempt_number === 1,
            finished_at: iso(attempt.exam_finished),
            time: attempt.time ?? 0,
            correct: attempt.questions_correct ?? 0,
            incorrect: attempt.questions_incorrect ?? 0,
            not_answered: attempt.questions_not_answered ?? 0,
            score: attempt.score ?? null,
            score_conversion: attempt.score_conversion ?? null,
        })),
        ranking,
        can_retry: blocked === null,
        retry_blocked_reason: enrollment ? blocked : null,
        server_time: now.toISOString(),
    };
};

// --- Solucionario -----------------------------------------------------------

export const getSolucionario = async ({ user, slug, area }) => {
    const now = new Date();
    const simulacrum = await findLight(slug);
    const full = await loadFull(simulacrum._id);

    const enrollment = await UserSimulacrumModel.findOne({ user_id: user._id, simulacrum_id: simulacrum._id, state: true }).lean().exec();
    const canTeach = canSeeSolutions(user);
    let answers = {};
    let useArea;
    let teacherPreview = false;

    if (enrollment) {
        // Con un intento abierto el solucionario se cierra: tener las respuestas a la vista mientras se rinde no mediria nada.
        if (enrollment.finished !== true) throw ApiError.forbidden('El solucionario se habilita cuando termines tu intento.');
        if (settings.limits.solucionarioRequiresPlan && !isPremium(user, now)) throw ApiError.subscriptionRequired('Necesitas una suscripción activa para ver el solucionario.', { backSlug: simulacrum.slug });
        // En un evento en curso, quien termina antes no puede pasarles las respuestas a los demas.
        if (simulacrum.automatic && simulacrumStatus(simulacrum, now) !== 'finished') {
            throw ApiError.forbidden('El solucionario se habilita cuando cierre el simulacro.');
        }
        answers = enrollment.answers ?? {};
        useArea = enrollment.area;
    } else if (canTeach) {
        // El docente no rinde: lo revisa como material, y solo con suscripcion activa.
        if (!isPremium(user, now)) throw ApiError.subscriptionRequired('Necesitas una suscripción activa para ver el solucionario del simulacro.', { backSlug: simulacrum.slug });
        const keys = isGeneralSimulacrum(full) ? [] : Object.keys(full.areas ?? {});
        useArea = keys.includes(area) ? area : keys[0];
        teacherPreview = true;
    } else {
        throw ApiError.notFound('No encontramos tu inscripción en este simulacro.');
    }

    const { items } = await loadQuestionSet(full, useArea);
    let number = 0;

    return {
        simulacrum: { id: simulacrum._id, slug: simulacrum.slug, title: simulacrum.title ?? null },
        area: useArea ?? null,
        // El docente revisa como material, sin intento propio.
        ...(teacherPreview ? { teacher_preview: true } : {}),
        items: items.map((item) => {
            if (item.kind === 'reading') return { kind: 'reading', id: item.id, title: item.title, text: absolutizeHtml(item.text), area: item.area };
            number += 1;
            const selected = answers[item.id]?.option ?? null;
            return {
                kind: 'question',
                id: item.id,
                n: number,
                area: item.area,
                topic: item.topic,
                question: absolutizeHtml(item.question),
                options: item.options.map((option) => ({ key: option.key, text: absolutizeHtml(option.text) })),
                correct: item.rpta,
                explanation: item.resolution ? absolutizeHtml(item.resolution) : null,
                selected,
                is_correct: selected !== null && selected === item.rpta,
            };
        }),
    };
};

const isGeneralSimulacrum = (simulacrum) => simulacrum.general !== false;

// --- Reintentar -------------------------------------------------------------

export const retry = async ({ user, slug }) => {
    const simulacrum = await SimulacrumModel.findOne({ slug }).lean().exec();
    if (!simulacrum) throw ApiError.notFound('No encontramos ese simulacro.');

    const enrollment = await UserSimulacrumModel.findOne({ user_id: user._id, simulacrum_id: simulacrum._id }).lean().exec();

    const blocked = retryBlockedReason(enrollment, simulacrum);
    if (blocked) {
        // "Sin inscripcion" es un 404; el resto son conflictos de estado que el postulante puede resolver.
        if (!enrollment) throw ApiError.notFound(blocked);
        throw ApiError.conflict(blocked);
    }

    // null = otra peticion (doble toque) gano la carrera y ya lo reinicio: el estado final es el pedido.
    const reset = await startNewAttempt(enrollment);
    const current = reset ?? (await UserSimulacrumModel.findById(enrollment._id).lean().exec());
    await invalidateProgress(user._id);

    return { attempt_id: current._id, attempt_number: attemptNumberOf(current) };
};
