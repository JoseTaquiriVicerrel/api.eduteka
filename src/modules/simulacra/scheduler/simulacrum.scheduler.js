// Reloj de los simulacros programados (plan de separacion de servicios, Fase 1).
//
// Sustituye a los `setTimeout` en memoria del monolito (eduteka/src/libs/simulacrum_realtime.js)
// por trabajos DIFERIDOS de BullMQ en la cola `simulacrum`:
//
//   - cada hito (close, start, end, results) es un trabajo con id determinista
//     `ms.<simulacro>.<hito>.<instante>`: programarlo dos veces no lo duplica, sobrevive a un
//     reinicio y no hay que borrar nada al cambiar fechas (el trabajo viejo ya no coincide con
//     `milestoneAt` y se descarta solo);
//   - `reconcile` (al arrancar y cada 5 min) es la red de seguridad, como en el monolito;
//   - el cierre es un FLUJO: el padre `close-window` corre cuando terminaron (o fallaron) los
//     hijos `grade-attempt`, uno por intento abierto, que califica src/worker.js. Recien entonces
//     se marca el simulacro como cerrado, se publican los resultados si toca y se avisa `end`.
//
// La verdad vive en Mongo; los trabajos solo dicen "revisa este simulacro ahora". Todos los
// manejadores releen la base y son idempotentes.

import { DelayedError } from 'bullmq';
import SimulacrumModel from '#Models/simulacrum_model.js';
import { addFlow, enqueue, getQueue } from '#Config/queue.js';
import { logger } from '#Libs/logger.js';
import { CONTRACT_VERSION, QUEUES } from '#Libs/queue_contracts.js';
import { publishSignal } from '../realtime/simulacrum.events.js';
import { PHASES, getPhase, milestoneAt, resultsDue, upcomingEvents } from '../simulacrum.window.js';
import { finalizeWindow, gradeOpenAttempt, markAbsent, openAttemptIds, publishResults } from './simulacrum.closing.js';

export const RECONCILE_EVERY_MS = 5 * 60 * 1000;
export const RECONCILE_SCHEDULER_ID = 'simulacrum-reconcile';

// Los ids de BullMQ no admiten ':'.
export const milestoneJobId = (simulacrumId, kind, at) => `ms.${simulacrumId}.${kind}.${at}`;
export const closeJobId = (simulacrumId) => `close.${simulacrumId}`;

// Un hito que se adelanta (reloj, promocion temprana) no se ejecuta antes de su hora: se re-difiere.
const EARLY_TOLERANCE_MS = 0;
const RERUN_STATES = new Set(['completed', 'failed']);

const MILESTONE_OPTIONS = Object.freeze({ attempts: 5, backoff: Object.freeze({ type: 'exponential', delay: 2_000 }) });

/** Programa todos los hitos futuros del simulacro. Idempotente. Devuelve cuantos hay. */
export const scheduleSimulacrum = async (sim, now = new Date()) => {
    const events = upcomingEvents(sim, now);
    for (const event of events) {
        await enqueue(QUEUES.SIMULACRUM, 'milestone', {
            v: CONTRACT_VERSION, simulacrum_id: String(sim._id), kind: event.kind, at: event.at,
        }, {
            ...MILESTONE_OPTIONS,
            jobId: milestoneJobId(sim._id, event.kind, event.at),
            delay: Math.max(0, event.at - now.getTime()),
        });
    }
    return events.length;
};

/**
 * Arranca el cierre de la ventana si no hay uno en curso: marca ausentes y crea el flujo
 * (un `grade-attempt` por intento abierto, y el padre `close-window`). Idempotente: con un cierre
 * en curso no hace nada; uno ya terminado se reemplaza (el simulacro volvio a quedar abierto).
 */
export const ensureCloseWindow = async (simulacrumId) => {
    const id = String(simulacrumId);
    const jobId = closeJobId(id);
    const existing = await getQueue(QUEUES.SIMULACRUM).getJob(jobId);
    if (existing) {
        const state = await existing.getState();
        if (!RERUN_STATES.has(state)) return { started: false, state };
        await existing.remove({ removeChildren: true });
    }

    const absent = await markAbsent(id);
    const open = await openAttemptIds(id);
    await addFlow({
        name: 'close-window',
        queueName: QUEUES.SIMULACRUM,
        data: { v: CONTRACT_VERSION, simulacrum_id: id },
        opts: { jobId, attempts: 5, backoff: { type: 'exponential', delay: 2_000 } },
        children: open.map((userSimulacrumId) => ({
            name: 'grade-attempt',
            queueName: QUEUES.SIMULACRUM_GRADING,
            data: { v: CONTRACT_VERSION, simulacrum_id: id, user_simulacrum_id: userSimulacrumId },
            // Un intento que no se pudo calificar no detiene el cierre: queda abierto y se califica
            // de forma perezosa cuando su dueño pide el resultado (attemptExpired).
            opts: { attempts: 2, backoff: { type: 'fixed', delay: 2_000 }, ignoreDependencyOnFailure: true },
        })),
    });
    logger.info({ simulacrum: id, open: open.length, absent }, 'Cierre de ventana iniciado');
    return { started: true, open: open.length, absent };
};

/**
 * Lo que toca HOY con un simulacro programado: cerrarlo si su ventana ya paso, publicar
 * resultados pendientes y dejar programados sus hitos. Lo usan `reconcile` y la senal `updated`.
 */
export const reconcileOne = async (sim, now = new Date()) => {
    if (sim.finished !== true && getPhase(sim, now) === PHASES.FINISHED) {
        await ensureCloseWindow(sim._id);
    } else if (sim.finished === true && resultsDue(sim, now)) {
        if (await publishResults(sim._id)) {
            const fresh = await SimulacrumModel.findById(sim._id).lean().exec();
            if (fresh) await publishSignal('results', fresh);
        }
    }
    await scheduleSimulacrum(sim, now);
};

/** Simulacros programados con algo pendiente: sin cerrar o con resultados sin publicar. */
const pendingScheduled = () => SimulacrumModel.find({
    start_date: { $ne: null },
    end_date: { $ne: null },
    $or: [{ finished: { $ne: true } }, { public_results: { $ne: true } }],
}).lean().exec();

// --- Manejadores (cola `simulacrum`, los consume src/scheduler.js) -------------------------------

const milestone = async (job, token) => {
    const { simulacrum_id: id, kind, at } = job.data;
    const now = new Date();

    if (at - now.getTime() > EARLY_TOLERANCE_MS) {
        await job.moveToDelayed(at, token);
        throw new DelayedError();
    }

    const sim = await SimulacrumModel.findById(id).lean().exec();
    if (!sim) return { skipped: 'missing' };
    // Las fechas cambiaron despues de programarlo: este hito ya no existe (el nuevo ya esta programado).
    if (milestoneAt(sim, kind) !== at) return { skipped: 'stale' };

    const phase = getPhase(sim, now);
    if (kind === 'close') {
        if (phase !== PHASES.WAITING) return { skipped: phase };
        await publishSignal('close', sim);
    } else if (kind === 'start') {
        if (phase !== PHASES.LIVE) return { skipped: phase };
        await publishSignal('start', sim);
    } else if (kind === 'end') {
        return ensureCloseWindow(id);
    } else if (kind === 'results') {
        // Sin cerrar todavia (el cierre fallo o va tarde): el propio cierre publicara al terminar.
        if (sim.finished !== true) return ensureCloseWindow(id);
        if (await publishResults(id)) {
            const fresh = await SimulacrumModel.findById(id).lean().exec();
            if (fresh) await publishSignal('results', fresh);
        }
    }
    return { done: kind };
};

const reconcile = async () => {
    const sims = await pendingScheduled();
    let failed = 0;
    for (const sim of sims) {
        try {
            await reconcileOne(sim);
        } catch (error) {
            failed += 1;
            logger.error({ err: error?.message, simulacrum: sim._id }, 'Reconciliacion de simulacro fallida');
        }
    }
    return { simulacra: sims.length, failed };
};

const closeWindow = async (job) => {
    const id = job.data.simulacrum_id;
    const values = await job.getChildrenValues();
    const failures = await job.getIgnoredChildrenFailures();
    const graded = Object.values(values).filter((value) => value === 'graded').length;

    const { simulacrum, published } = await finalizeWindow(id);
    if (!simulacrum) return { skipped: 'missing' };

    await publishSignal('end', simulacrum);
    if (published) await publishSignal('results', simulacrum);
    // Resultados programados para despues del fin: su hito sigue (o se vuelve a) programar.
    await scheduleSimulacrum(simulacrum);

    const failed = Object.keys(failures).length;
    if (failed) logger.warn({ simulacrum: id, failed }, 'Intentos sin calificar al cerrar; se calificaran al pedir el resultado');
    logger.info({ simulacrum: id, graded, failed, published }, 'Ventana cerrada');
    return { graded, failed, published };
};

export const schedulerHandlers = Object.freeze({ milestone, reconcile, 'close-window': closeWindow });

// --- Manejador de calificacion (cola `simulacrum-grading`, lo consume src/worker.js) -------------

export const gradingHandlers = Object.freeze({
    'grade-attempt': (job) => gradeOpenAttempt({
        simulacrumId: job.data.simulacrum_id,
        userSimulacrumId: job.data.user_simulacrum_id,
    }),
});

/** Deja programada la reconciliacion periodica (idempotente: upsert por id). */
export const ensureReconcileSchedule = async () => getQueue(QUEUES.SIMULACRUM).upsertJobScheduler(
    RECONCILE_SCHEDULER_ID,
    { every: RECONCILE_EVERY_MS },
    { name: 'reconcile', data: { v: CONTRACT_VERSION }, opts: { attempts: 1 } },
);
