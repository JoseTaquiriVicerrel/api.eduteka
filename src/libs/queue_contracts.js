// Contrato de las colas (BullMQ): nombres, trabajos y la forma de cada carga util.
//
// Es la UNICA definicion. El monolito encola en algunas de estas colas (fases 2 y 3 del plan de
// separacion de servicios) con una copia de este archivo y una prueba de paridad, igual que
// simulacrum_window.
//
// Reglas (las mismas que el bus de senales, simulacrum.events.js):
//   - la carga util lleva IDENTIFICADORES, no documentos: quien procesa lee la verdad de Mongo;
//   - todo trabajo es idempotente: repetirlo (reintento, reinicio a medias) no hace dano;
//   - `v` versiona la forma: un consumidor rechaza (sin reintentar) una version que no conoce.
//
// Una cola nueva se agrega aqui con su esquema y su prueba en test/queue_contracts.test.js.

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const CONTRACT_VERSION = 1;

export const QUEUES = Object.freeze({
    // Mantenimiento y comprobacion de extremo a extremo (scripts/queue_ping.js).
    SYSTEM: 'system',
    // Reloj de los simulacros programados (lo consume src/scheduler.js): hitos diferidos,
    // reconciliacion periodica y cierre de la ventana.
    SIMULACRUM: 'simulacrum',
    // Calificacion de cada intento abierto al cerrar la ventana (lo consume src/worker.js).
    SIMULACRUM_GRADING: 'simulacrum-grading',
    // Documentos (lo consume src/docs.js): HTML -> PDF con Chromium y DOCX -> PDF con LibreOffice.
    // Lo usan el monolito (listas, examenes, compendios, materiales) y, mas adelante, la API.
    DOCS: 'docs',
});

const Iso = Type.String({ minLength: 10, maxLength: 40 });
// Los _id son cadenas (UUID o nanoid), no ObjectId.
const Id = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' });
const MILESTONE_KINDS = ['close', 'start', 'end', 'results'];
// Clave del almacenamiento de objetos (mismas reglas que assertValidKey de #Libs/object_storage.js).
// Los documentos no viajan en la cola: van al almacenamiento y aqui solo va su clave.
// Sin segmentos `.` ni `..` (el lookahead): el juego de caracteres por si solo los dejaria pasar.
const ObjectKey = Type.String({ minLength: 1, maxLength: 512, pattern: '^(?!(?:.*/)?\\.{1,2}(?:/|$))[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$' });

const JOBS = Object.freeze({
    [QUEUES.SYSTEM]: Object.freeze({
        ping: Type.Object({
            v: Type.Literal(CONTRACT_VERSION),
            sent_at: Iso,
            from: Type.String({ minLength: 1, maxLength: 60 }),
        }, { additionalProperties: false }),
    }),
    [QUEUES.SIMULACRUM]: Object.freeze({
        // Hito diferido. `at` es el instante con el que se programo: si el admin movio las fechas,
        // ya no coincide con el del simulacro y el trabajo se descarta (milestoneAt).
        milestone: Type.Object({
            v: Type.Literal(CONTRACT_VERSION),
            simulacrum_id: Id,
            kind: Type.Union(MILESTONE_KINDS.map((kind) => Type.Literal(kind))),
            at: Type.Integer({ minimum: 0 }),
        }, { additionalProperties: false }),
        // Recalcula el estado de todos los programados abiertos (al arrancar y cada 5 min).
        reconcile: Type.Object({ v: Type.Literal(CONTRACT_VERSION) }, { additionalProperties: false }),
        // Padre del flujo de cierre: corre cuando terminaron (o fallaron) todas sus calificaciones.
        'close-window': Type.Object({
            v: Type.Literal(CONTRACT_VERSION),
            simulacrum_id: Id,
        }, { additionalProperties: false }),
    }),
    [QUEUES.SIMULACRUM_GRADING]: Object.freeze({
        'grade-attempt': Type.Object({
            v: Type.Literal(CONTRACT_VERSION),
            simulacrum_id: Id,
            user_simulacrum_id: Id,
        }, { additionalProperties: false }),
    }),
    [QUEUES.DOCS]: Object.freeze({
        // Imprime un HTML ya armado (plantilla compilada, imagenes y fuentes incrustadas) a PDF A4.
        // `output_key` es determinista (hash del contenido): si ya existe, no se vuelve a imprimir.
        'print-pdf': Type.Object({
            v: Type.Literal(CONTRACT_VERSION),
            html_key: ObjectKey,
            output_key: ObjectKey,
            // Titulo de la cabecera. Texto plano: se escapa antes de ir al HTML de la cabecera.
            title: Type.String({ maxLength: 300 }),
            header_footer: Type.Boolean(),
            watermark: Type.Boolean(),
        }, { additionalProperties: false }),
        // Convierte un .docx (material del docente) a PDF con LibreOffice.
        'docx-pdf': Type.Object({
            v: Type.Literal(CONTRACT_VERSION),
            docx_key: ObjectKey,
            output_key: ObjectKey,
        }, { additionalProperties: false }),
    }),
});

// Reintentos y limpieza por defecto. Los trabajos terminados se conservan un tiempo para poder
// diagnosticar; la verdad de negocio no depende de ellos (vive en Mongo).
export const DEFAULT_JOB_OPTIONS = Object.freeze({
    attempts: 3,
    backoff: Object.freeze({ type: 'exponential', delay: 5_000 }),
    removeOnComplete: Object.freeze({ age: 24 * 3600, count: 1000 }),
    removeOnFail: Object.freeze({ age: 7 * 24 * 3600, count: 5000 }),
});

export class InvalidJobError extends Error {
    constructor(message, details = []) {
        super(message);
        this.name = 'InvalidJobError';
        this.details = details;
    }
}

export const queueNames = () => Object.values(QUEUES);

export const jobNames = (queue) => Object.keys(JOBS[queue] ?? {});

/**
 * Valida una carga util contra el contrato. Devuelve la carga tal cual o lanza InvalidJobError.
 * La usan tanto quien encola (para no meter basura en la cola) como quien procesa (para no
 * procesar algo que otro proceso, con otra version del contrato, encolo mal).
 */
export const validateJob = (queue, name, data) => {
    const schema = JOBS[queue]?.[name];
    if (!schema) throw new InvalidJobError(`Trabajo desconocido: ${queue}/${name}`);
    if (!Value.Check(schema, data)) {
        const details = [...Value.Errors(schema, data)].slice(0, 5).map((error) => `${error.path || '/'} ${error.message}`);
        throw new InvalidJobError(`Carga util invalida para ${queue}/${name}`, details);
    }
    return data;
};
