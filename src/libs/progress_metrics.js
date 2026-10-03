import { convertSlug } from '#Libs/functions.js';
import { formatAreaName } from '#Libs/area_utils.js';
import {
    DAY_MS, dayKeyOf, shiftDayKey, weekKeyOfDayKey, startOfIsoWeek, startOfDay, daysBefore,
    buildAxis, limaParts, dayLabel, pct,
} from '#Libs/lima_time.js';

/**
 * Metricas de avance y progreso del postulante (/mi-progreso) y de la
 * poblacion (/admin/progreso).
 *
 * Modulo PURO: ni modelos ni Redis. Las consultas viven en
 * #Services/progress_stats.service.js y aqui entra lo que devuelven. Es la
 * parte que puede mentir en pantalla (fechas, deduplicacion, porcentajes), y por
 * eso se prueba sin base de datos (test/progress/progress_metrics.test.js).
 *
 * DE DONDE SALE CADA CIFRA
 * ------------------------
 * - Examenes y practicas = `useranswers`. Una fila por (usuario, pregunta),
 *   fechada por `created_at`: cada pregunta cuenta UNA vez, el dia en que se
 *   respondio por primera vez. Volver a responderla no suma actividad (la fila
 *   solo cambia `answer`). Es una decision consciente: no se toca el guardado.
 * - Simulacros = intentos calificados, con las cifras OFICIALES del intento
 *   (questions_correct/incorrect, results por area). Asi coinciden con
 *   /simulacros/:slug/resultados.
 * - Practicas terminadas (`practiceattempts`) = solo senal de actividad: sus
 *   respuestas ya estan en `useranswers`, sumarlas contaria doble.
 *
 * Aciertos = correctas / respondidas CON CLAVE. Una pregunta sin `rpta` no se
 * puede corregir: cuenta como respondida pero no entra al porcentaje.
 */

// Area mas debil: la de menor porcentaje con al menos este numero de
// respuestas con clave. Con menos, una sola falla decide el area.
export const WEAK_AREA_MIN_KEYED = 10;
export const WEAK_TOPIC_MIN_KEYED = 5;
export const ADMIN_WEAK_AREA_MIN_KEYED = 50;

export const STUDENT_DAYS = 30;
export const STUDENT_WEEKS = 12;
export const TOP_TOPICS = 8;
// Con menos intentos la linea de evolucion no dice nada que la lista no diga.
export const EVOLUTION_CHART_MIN = 3;

export const NO_AREA = Object.freeze({ key: 'sin-area', name: 'Sin área', slug: null });

export const ACTIVE_DAY_BUCKETS = Object.freeze([
    { label: '1 día', min: 1, max: 1 },
    { label: '2 a 3 días', min: 2, max: 3 },
    { label: '4 a 7 días', min: 4, max: 7 },
    { label: '8 a 14 días', min: 8, max: 14 },
    { label: '15 días o más', min: 15, max: Infinity },
]);

const WEEKDAY_LETTERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const WEEKDAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

// --- Base -------------------------------------------------------------------

/** La pregunta tiene clave. Hay `rpta` null y tambien '' en la base. */
export const isKeyed = (rpta) => rpta !== null && rpta !== undefined && String(rpta).trim() !== '';

/**
 * Date valido o null. En usersimulacrums hay fechas ausentes y hasta
 * `start_exam` guardado como string: no se puede dar nada por hecho.
 */
export const toDate = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const slugOf = (text) => convertSlug(String(text ?? ''));

/** Catalogo de areas indexado por _id y por slug. */
export const buildCatalog = (areas = []) => {
    const byId = new Map();
    const bySlug = new Map();

    for (const area of areas) {
        if (!area?._id) continue;
        const entry = { key: String(area._id), name: area.name || formatAreaName(area.slug ?? ''), slug: area.slug ?? null };
        byId.set(entry.key, entry);
        if (entry.slug) bySlug.set(entry.slug, entry);
    }

    return { byId, bySlug };
};

/**
 * Area de catalogo de una pregunta, o del texto de area de un resultado de
 * simulacro. El enlace es el mismo que usa #Libs/area_link.js: por slug, asi
 * "ANATOMÍA", "Anatomia" y el `area_id` caen en la misma area.
 */
export const resolveArea = (catalog, { area_id: areaId = null, area = null } = {}) => {
    if (areaId && catalog.byId.has(String(areaId))) return catalog.byId.get(String(areaId));

    const slug = slugOf(area);
    if (slug && catalog.bySlug.has(slug)) return catalog.bySlug.get(slug);
    if (slug) return { key: `txt:${slug}`, name: formatAreaName(String(area)), slug: null };

    return NO_AREA;
};

/**
 * JSON para pintar crudo dentro de <script type="application/json">. El helper
 * `json` de Handlebars no escapa nada: un `</script>` en un dato cerraria la
 * etiqueta. U+2028/2029 rompen los parsers de JS antiguos.
 */
// Construidos con fromCharCode: escritos literales, U+2028/2029 son saltos de
// linea para el parser y rompen el propio archivo.
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

export const toScriptJson = (value) => JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');

const inWindow = (date, from, to) => !!date && date >= from && date <= to;

// --- Normalizacion ----------------------------------------------------------

/**
 * Respuestas de examenes y practicas del postulante, una por pregunta.
 *
 * La base tiene duplicados (usuario, pregunta): la regla de una fila solo la
 * imponen los controladores. Se junta en una: la fecha es la mas antigua (el
 * dia en que la respondio por primera vez) y la opcion, la del ultimo cambio.
 *
 * Una pregunta que ya no existe cuenta como respondida, sin clave y sin area.
 */
export const normalizeAnswers = (docs = [], questionById = new Map(), catalog = buildCatalog()) => {
    const byQuestion = new Map();

    for (const doc of docs) {
        const at = toDate(doc?.created_at);
        if (!doc?.question_id || !at) continue;

        const id = String(doc.question_id);
        const changed = toDate(doc.updated_at) ?? at;
        const current = byQuestion.get(id);

        if (!current) {
            byQuestion.set(id, { at, changed, answer: doc.answer });
            continue;
        }
        if (at < current.at) current.at = at;
        if (changed > current.changed) {
            current.changed = changed;
            current.answer = doc.answer;
        }
    }

    const events = [];
    for (const [id, { at, answer }] of byQuestion) {
        const question = questionById.get(id) ?? null;
        const keyed = !!question && isKeyed(question.rpta);
        const topic = typeof question?.topic === 'string' ? question.topic.trim() : '';

        events.push({
            question_id: id,
            at,
            day: dayKeyOf(at),
            keyed,
            correct: keyed && answer === question.rpta,
            area: question ? resolveArea(catalog, question) : NO_AREA,
            topic: topic || null,
        });
    }

    return events.sort((a, b) => a.at - b.at);
};

const isGraded = (doc) => Number.isFinite(doc?.questions_correct);
const count = (value) => (Number.isFinite(value) ? value : 0);

/** `results` del intento como lista, reconstruyendo `questions_not_answered`. */
const normalizeResults = (results) => {
    if (!results || typeof results !== 'object') return [];

    return Object.entries(results).map(([area, row]) => {
        const correct = count(row?.questions_correct);
        const incorrect = count(row?.questions_incorrect);
        const total = count(row?.questions_count);
        const notAnswered = Number.isFinite(row?.questions_not_answered)
            ? row.questions_not_answered
            : Math.max(0, total - correct - incorrect);
        return { area, correct, incorrect, not_answered: notAnswered };
    });
};

const toAttempt = (doc, enrollmentId) => {
    const correct = count(doc.questions_correct);
    const incorrect = count(doc.questions_incorrect);
    const notAnswered = count(doc.questions_not_answered);
    const total = correct + incorrect + notAnswered;
    // `exam_finished` es el cierre real; los intentos calificados tarde lo
    // copian de `end_exam`, y a algunas filas antiguas les faltan los dos.
    const at = toDate(doc.exam_finished) ?? toDate(doc.end_exam) ?? toDate(doc.created_at);
    const attemptNumber = doc.attempt_number ?? 1;

    return {
        key: `${enrollmentId}|${attemptNumber}`,
        user_id: doc.user_id ? String(doc.user_id) : null,
        enrollment_id: String(enrollmentId),
        simulacrum_id: doc.simulacrum_id ? String(doc.simulacrum_id) : null,
        attempt_number: attemptNumber,
        at,
        day: at ? dayKeyOf(at) : null,
        correct,
        incorrect,
        not_answered: notAnswered,
        total,
        answered: correct + incorrect,
        pct_total: pct(correct, total),
        score: Number.isFinite(doc.score) ? doc.score : null,
        score_conversion: Number.isFinite(doc.score_conversion) ? doc.score_conversion : null,
        results: normalizeResults(doc.results),
    };
};

/**
 * Intentos de simulacro calificados, sin repetir.
 *
 * El intento vigente se archiva al calificarlo, asi que suele estar en las dos
 * colecciones; las inscripciones anteriores a los reintentos solo estan en
 * `usersimulacrums`. Misma regla que simulacrumAttemptService.listAttempts: la
 * clave es (inscripcion, numero de intento) y gana la fila viva. Sin
 * `attempt_number` es el intento 1 (attemptNumberOf).
 *
 * La fila viva solo cuenta cerrada: con un reintento en curso conserva todavia
 * los numeros del intento anterior, que ya estan en el archivo.
 */
export const mergeGradedAttempts = (archived = [], live = []) => {
    const byKey = new Map();

    for (const doc of archived) {
        if (!isGraded(doc) || !doc.user_simulacrum_id) continue;
        const attempt = toAttempt(doc, doc.user_simulacrum_id);
        byKey.set(attempt.key, attempt);
    }

    for (const doc of live) {
        if (doc?.finished !== true || !isGraded(doc) || !doc._id) continue;
        const attempt = toAttempt(doc, doc._id);
        byKey.set(attempt.key, attempt);
    }

    return [...byKey.values()].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
};

// --- Series y totales -------------------------------------------------------

const emptyTotals = () => ({ practice: 0, simulacro: 0, keyed: 0, correct: 0 });

/** Cifras por dia de Lima: { practice, simulacro, keyed, correct }. */
export const dayTotals = ({ answers = [], attempts = [] }) => {
    const byDay = new Map();
    const bucket = (day) => {
        if (!byDay.has(day)) byDay.set(day, emptyTotals());
        return byDay.get(day);
    };

    for (const event of answers) {
        const row = bucket(event.day);
        row.practice += 1;
        if (event.keyed) row.keyed += 1;
        if (event.correct) row.correct += 1;
    }

    for (const attempt of attempts) {
        if (!attempt.day) continue;
        const row = bucket(attempt.day);
        row.simulacro += attempt.answered;
        row.keyed += attempt.answered;
        row.correct += attempt.correct;
    }

    return byDay;
};

/**
 * Serie alineada al eje. En semanal los dias se suman a su semana ISO: Mongo
 * agrupa siempre por dia y la semana se arma aqui.
 */
export const rollupSeries = (axisKeys, unit, byDay) => {
    const byBucket = new Map();

    for (const [day, row] of byDay) {
        const key = unit === 'week' ? weekKeyOfDayKey(day) : day;
        if (!byBucket.has(key)) byBucket.set(key, emptyTotals());
        const target = byBucket.get(key);
        target.practice += row.practice;
        target.simulacro += row.simulacro;
        target.keyed += row.keyed;
        target.correct += row.correct;
    }

    const rows = axisKeys.map((key) => byBucket.get(key) ?? emptyTotals());
    return {
        practice: rows.map((row) => row.practice),
        simulacro: rows.map((row) => row.simulacro),
        answered: rows.map((row) => row.practice + row.simulacro),
        // null y no 0: un dia sin preguntas no es un dia con 0% de aciertos.
        accuracy: rows.map((row) => pct(row.correct, row.keyed)),
    };
};

/** Totales entre dos instantes exactos. */
export const windowTotals = ({ answers = [], attempts = [] }, from, to) => {
    const totals = emptyTotals();

    for (const event of answers) {
        if (!inWindow(event.at, from, to)) continue;
        totals.practice += 1;
        if (event.keyed) totals.keyed += 1;
        if (event.correct) totals.correct += 1;
    }

    for (const attempt of attempts) {
        if (!inWindow(attempt.at, from, to)) continue;
        totals.simulacro += attempt.answered;
        totals.keyed += attempt.answered;
        totals.correct += attempt.correct;
    }

    return { ...totals, answered: totals.practice + totals.simulacro, accuracy: pct(totals.correct, totals.keyed) };
};

/**
 * Esta semana (lunes 00:00 hasta ahora) contra el mismo tramo de la anterior
 * (lunes pasado hasta ahora - 7 dias). Comparar con la semana pasada entera
 * haria que todos los lunes parezcan una caida.
 */
export const weekWindow = (now) => {
    const from = startOfIsoWeek(now);
    return {
        cur: { from, to: now },
        prev: { from: new Date(from.getTime() - 7 * DAY_MS), to: new Date(now.getTime() - 7 * DAY_MS) },
    };
};

/**
 * Variacion del volumen (%) y de los aciertos (puntos). `trend` resume el
 * volumen para la vista: 'new' si antes no hubo nada, 'none' si tampoco ahora.
 */
/** Variacion porcentual entera, o null si antes no habia nada. */
export const changePct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

/** 'up' | 'down' | 'flat' | 'new' (antes cero) | 'none' (cero y cero). */
export const trendOf = (cur, prev) => {
    if (!prev && !cur) return 'none';
    if (!prev) return 'new';
    return cur > prev ? 'up' : cur < prev ? 'down' : 'flat';
};

export const compareTotals = (cur, prev) => {
    const volume = changePct(cur.answered, prev.answered);
    const trend = trendOf(cur.answered, prev.answered);

    const accuracy = cur.accuracy !== null && prev.accuracy !== null
        ? Math.round((cur.accuracy - prev.accuracy) * 10) / 10
        : null;

    return { volume_delta_pct: volume, accuracy_delta_points: accuracy, trend };
};

// --- Constancia -------------------------------------------------------------

/** Dias de Lima con alguna actividad: respuesta nueva, simulacro o practica. */
export const activeDaySet = ({ answers = [], attempts = [], practiceDates = [] }) => {
    const days = new Set();
    for (const event of answers) days.add(event.day);
    for (const attempt of attempts) if (attempt.day) days.add(attempt.day);
    for (const value of practiceDates) {
        const date = toDate(value);
        if (date) days.add(dayKeyOf(date));
    }
    return days;
};

/**
 * Racha de dias seguidos. Si hoy todavia no hubo actividad pero ayer si, la
 * racha sigue viva ('pending'): el dia no ha terminado y romperla a las 8 de la
 * manana seria injusto.
 */
export const computeStreak = (days, todayKey) => {
    const sorted = [...days].sort();

    let best = 0;
    let run = 0;
    let previous = null;
    for (const day of sorted) {
        run = previous && shiftDayKey(previous, 1) === day ? run + 1 : 1;
        if (run > best) best = run;
        previous = day;
    }

    const yesterday = shiftDayKey(todayKey, -1);
    const status = days.has(todayKey) ? 'today' : days.has(yesterday) ? 'pending' : 'none';

    let current = 0;
    if (status !== 'none') {
        let cursor = status === 'today' ? todayKey : yesterday;
        while (days.has(cursor)) {
            current += 1;
            cursor = shiftDayKey(cursor, -1);
        }
    }

    return { current, best, status, last_day: sorted.length ? sorted[sorted.length - 1] : null };
};

/** Los 7 dias de la semana en curso, de lunes a domingo. */
export const weekDots = (days, now) => {
    const monday = dayKeyOf(startOfIsoWeek(now));
    const today = dayKeyOf(now);

    return WEEKDAY_LETTERS.map((letter, index) => {
        const key = shiftDayKey(monday, index);
        return {
            letter,
            name: WEEKDAY_NAMES[index],
            active: days.has(key),
            is_today: key === today,
            // Las claves 'YYYY-MM-DD' ordenan como fechas.
            is_future: key > today,
        };
    });
};

// --- Areas y temas ----------------------------------------------------------

const newAreaRow = (area) => ({
    key: area.key,
    name: area.name,
    slug: area.slug,
    answered: 0,
    keyed: 0,
    correct: 0,
    sim_answered: 0,
    sim_correct: 0,
    topics: new Map(),
});

const pickWeakest = (rows, minKeyed, keyedOf, accuracyOf, answeredOf) => {
    let weakest = null;
    for (const row of rows) {
        if (row.key === NO_AREA.key || keyedOf(row) < minKeyed) continue;
        const accuracy = accuracyOf(row);
        if (accuracy === null) continue;
        if (!weakest
            || accuracy < accuracyOf(weakest)
            || (accuracy === accuracyOf(weakest) && answeredOf(row) > answeredOf(weakest))) {
            weakest = row;
        }
    }
    return weakest;
};

/**
 * Avance por area (todo el historial del postulante).
 *
 * - `answered`: preguntas DISTINTAS de examenes y practicas.
 * - `sim_answered`: respuestas en simulacros (cifras oficiales por area).
 * - `accuracy`: combinada sobre respuestas con clave de las dos fuentes.
 * - `coverage`: preguntas distintas con clave respondidas sobre las
 *   practicables del area (practiceService.getAreas). Solo para areas del
 *   catalogo.
 * - Temas: solo de examenes y practicas; los resultados de simulacro no bajan a
 *   tema. Se marca el tema mas flojo de cada area.
 */
export const areaProgress = ({
    answers = [], attempts = [], catalog = buildCatalog(), practicable = new Map(),
    minKeyed = WEAK_AREA_MIN_KEYED, minTopicKeyed = WEAK_TOPIC_MIN_KEYED, topTopics = TOP_TOPICS,
}) => {
    const byArea = new Map();
    const rowFor = (area) => {
        if (!byArea.has(area.key)) byArea.set(area.key, newAreaRow(area));
        return byArea.get(area.key);
    };

    for (const event of answers) {
        const row = rowFor(event.area);
        row.answered += 1;
        if (event.keyed) row.keyed += 1;
        if (event.correct) row.correct += 1;

        if (event.topic) {
            const key = slugOf(event.topic) || event.topic;
            if (!row.topics.has(key)) row.topics.set(key, { name: event.topic, answered: 0, keyed: 0, correct: 0 });
            const topic = row.topics.get(key);
            topic.answered += 1;
            if (event.keyed) topic.keyed += 1;
            if (event.correct) topic.correct += 1;
        }
    }

    for (const attempt of attempts) {
        for (const result of attempt.results) {
            const row = rowFor(resolveArea(catalog, { area: result.area }));
            row.sim_answered += result.correct + result.incorrect;
            row.sim_correct += result.correct;
        }
    }

    const areas = [...byArea.values()].map((row) => {
        const totalKeyed = row.keyed + row.sim_answered;
        const practicableCount = practicable.get(row.key) ?? 0;

        const topics = [...row.topics.values()]
            .map((topic) => ({ ...topic, accuracy: pct(topic.correct, topic.keyed) }))
            .sort((a, b) => b.answered - a.answered || a.name.localeCompare(b.name, 'es'));
        const weakTopic = pickWeakest(
            topics.map((topic) => ({ ...topic, key: topic.name })),
            minTopicKeyed, (t) => t.keyed, (t) => t.accuracy, (t) => t.answered,
        );

        return {
            key: row.key,
            name: row.name,
            slug: row.slug,
            answered: row.answered,
            keyed: row.keyed,
            correct: row.correct,
            sim_answered: row.sim_answered,
            sim_correct: row.sim_correct,
            total_answered: row.answered + row.sim_answered,
            total_keyed: totalKeyed,
            accuracy: pct(row.correct + row.sim_correct, totalKeyed),
            coverage: practicableCount > 0
                ? { done: row.keyed, total: practicableCount, pct: Math.min(100, pct(row.keyed, practicableCount)) }
                : null,
            topics: topics.slice(0, topTopics).map((topic) => ({ ...topic, weak: !!weakTopic && topic.name === weakTopic.name })),
            topics_total: topics.length,
            is_weakest: false,
        };
    });

    areas.sort((a, b) => {
        // "Sin area" siempre al final: no es un area que se pueda reforzar.
        if ((a.key === NO_AREA.key) !== (b.key === NO_AREA.key)) return a.key === NO_AREA.key ? 1 : -1;
        return b.total_answered - a.total_answered || a.name.localeCompare(b.name, 'es');
    });

    const weakest = pickWeakest(areas, minKeyed, (a) => a.total_keyed, (a) => a.accuracy, (a) => a.total_answered);
    if (weakest) weakest.is_weakest = true;

    return { areas, weakest };
};

// --- Simulacros -------------------------------------------------------------

/**
 * Evolucion en simulacros. Los puntajes de simulacros distintos no se comparan
 * (cada prospecto tiene su escala), asi que la tendencia se mide con el % de
 * aciertos sobre el total de preguntas, que es comparable. `delta_points` es
 * contra el intento anterior en el tiempo, del simulacro que sea.
 */
export const simulacroEvolution = (attempts = []) => {
    const chronological = [...attempts];
    const items = chronological.map((attempt, index) => {
        const previous = index > 0 ? chronological[index - 1] : null;
        const delta = previous && attempt.pct_total !== null && previous.pct_total !== null
            ? Math.round((attempt.pct_total - previous.pct_total) * 10) / 10
            : null;
        return { ...attempt, order: index + 1, delta_points: delta };
    });

    const dated = items.filter((item) => item.at && item.pct_total !== null);
    const chart = dated.length >= EVOLUTION_CHART_MIN
        ? {
            labels: dated.map((item) => `${item.order}. ${dayLabel(limaParts(item.at))}`),
            data: dated.map((item) => item.pct_total),
        }
        : null;

    return { items: items.reverse(), chart };
};

// --- Postulante -------------------------------------------------------------

/**
 * Todo lo del postulante a partir de los documentos crudos del servicio.
 *
 * @param {object} raw
 * @param {Array} raw.answerDocs   useranswers {question_id, answer, created_at, updated_at}
 * @param {Map}   raw.questionById id -> {rpta, area_id, area, topic}
 * @param {Array} raw.areas        catalogo {_id, name, slug}
 * @param {Array} raw.archived     simulacrumattempts
 * @param {Array} raw.live         usersimulacrums
 * @param {Array} raw.practiceDates created_at de practiceattempts
 * @param {Map}   raw.practicable  area_id -> preguntas practicables
 */
export const buildStudentProgress = (raw = {}, now = new Date()) => {
    const catalog = buildCatalog(raw.areas ?? []);
    const answers = normalizeAnswers(raw.answerDocs ?? [], raw.questionById ?? new Map(), catalog);
    const attempts = mergeGradedAttempts(raw.archived ?? [], raw.live ?? []);
    const practiceDates = raw.practiceDates ?? [];
    const data = { answers, attempts };

    const todayKey = dayKeyOf(now);
    const days = activeDaySet({ answers, attempts, practiceDates });
    const byDay = dayTotals(data);

    const dayAxis = buildAxis({ from: daysBefore(now, STUDENT_DAYS), to: now, unit: 'day' });
    const weekFrom = new Date(startOfIsoWeek(now).getTime() - (STUDENT_WEEKS - 1) * 7 * DAY_MS);
    const weekAxis = buildAxis({ from: weekFrom, to: now, unit: 'week' });

    const week = weekWindow(now);
    const weekCur = windowTotals(data, week.cur.from, week.cur.to);
    const weekPrev = windowTotals(data, week.prev.from, week.prev.to);

    // Historico: tambien los intentos sin fecha, que no caben en ninguna serie
    // pero si se rindieron.
    const simAnswered = attempts.reduce((acc, a) => acc + a.answered, 0);
    const simCorrect = attempts.reduce((acc, a) => acc + a.correct, 0);
    const keyed = answers.filter((e) => e.keyed).length + simAnswered;
    const correct = answers.filter((e) => e.correct).length + simCorrect;
    const last30From = daysBefore(now, STUDENT_DAYS);

    return {
        has_activity: days.size > 0,
        totals: {
            practice: answers.length,
            simulacro: simAnswered,
            answered: answers.length + simAnswered,
            keyed,
            correct,
            accuracy: pct(correct, keyed),
            simulacro_attempts: attempts.length,
            practices_finished: practiceDates.length,
        },
        today: windowTotals(data, startOfDay(now), now),
        week: { cur: weekCur, prev: weekPrev, compare: compareTotals(weekCur, weekPrev) },
        streak: computeStreak(days, todayKey),
        week_dots: weekDots(days, now),
        active_days_30: [...days].filter((day) => day >= dayKeyOf(last30From)).length,
        series: {
            day: { labels: dayAxis.labels, ...rollupSeries(dayAxis.keys, 'day', byDay) },
            week: { labels: weekAxis.labels, ...rollupSeries(weekAxis.keys, 'week', byDay) },
        },
        areas: areaProgress({ answers, attempts, catalog, practicable: raw.practicable ?? new Map() }),
        simulacros: simulacroEvolution(attempts),
    };
};

// --- Poblacion (admin) ------------------------------------------------------

const emptyPeriod = () => ({
    practice: 0, simulacro: 0, keyed: 0, correct: 0, attempts: 0, practices: 0, users: new Set(),
});

const finishPeriod = (period) => ({
    practice: period.practice,
    simulacro: period.simulacro,
    answered: period.practice + period.simulacro,
    keyed: period.keyed,
    correct: period.correct,
    accuracy: pct(period.correct, period.keyed),
    attempts: period.attempts,
    practices: period.practices,
    active: period.users.size,
});

/**
 * Cifras del rango y del periodo anterior para /admin/progreso.
 *
 * `rows` sale de agrupar useranswers por {d: dia, q: pregunta, a: opcion} con
 * los usuarios en un $addToSet: una fila = `users.length` respuestas. El
 * periodo anterior termina antes de `from`, asi que el dia decide a cual
 * pertenece cada fila.
 *
 * Los usuarios distintos por semana salen de UNIR los conjuntos diarios; sumar
 * los activos de cada dia contaria varias veces al que practica a diario.
 */
export const summarizePopulation = ({
    rows = [], questionById = new Map(), areas: areaDocs = [], attempts = [], practices = [], range, prevRange,
}) => {
    const catalog = buildCatalog(areaDocs);
    const axis = buildAxis(range);
    const fromKey = dayKeyOf(range.from);
    const bucketOf = (day) => (range.unit === 'week' ? weekKeyOfDayKey(day) : day);

    const cur = emptyPeriod();
    const prev = emptyPeriod();
    const buckets = new Map();
    const bucket = (day) => {
        const key = bucketOf(day);
        if (!buckets.has(key)) buckets.set(key, { ...emptyTotals(), attempts: 0, users: new Set() });
        return buckets.get(key);
    };

    const userStats = new Map();
    const userRow = (id) => {
        if (!userStats.has(id)) userStats.set(id, { answered: 0, keyed: 0, correct: 0, days: new Set(), last_day: null });
        return userStats.get(id);
    };
    const touch = (id, day) => {
        const stats = userRow(id);
        stats.days.add(day);
        if (!stats.last_day || day > stats.last_day) stats.last_day = day;
        return stats;
    };

    const byArea = new Map();
    const areaRow = (area) => {
        if (!byArea.has(area.key)) byArea.set(area.key, { ...area, answered: 0, keyed: 0, correct: 0, users: new Set() });
        return byArea.get(area.key);
    };

    for (const row of rows) {
        const day = row?._id?.d;
        const users = (row?.users ?? []).filter(Boolean).map(String);
        if (!day || !users.length) continue;

        const question = questionById.get(String(row._id.q)) ?? null;
        const keyed = !!question && isKeyed(question.rpta);
        const correct = keyed && row._id.a === question.rpta;
        const n = users.length;

        const period = day >= fromKey ? cur : prev;
        period.practice += n;
        if (keyed) period.keyed += n;
        if (correct) period.correct += n;
        users.forEach((user) => period.users.add(user));

        if (period !== cur) continue;

        const target = bucket(day);
        target.practice += n;
        if (keyed) target.keyed += n;
        if (correct) target.correct += n;
        users.forEach((user) => target.users.add(user));

        const area = areaRow(question ? resolveArea(catalog, question) : NO_AREA);
        area.answered += n;
        if (keyed) area.keyed += n;
        if (correct) area.correct += n;
        users.forEach((user) => area.users.add(user));

        for (const user of users) {
            const stats = touch(user, day);
            stats.answered += 1;
            if (keyed) stats.keyed += 1;
            if (correct) stats.correct += 1;
        }
    }

    for (const attempt of attempts) {
        if (!attempt.at || !attempt.user_id) continue;

        const inCur = inWindow(attempt.at, range.from, range.to);
        const inPrev = inWindow(attempt.at, prevRange.from, prevRange.to);
        if (!inCur && !inPrev) continue;

        const period = inCur ? cur : prev;
        period.simulacro += attempt.answered;
        period.keyed += attempt.answered;
        period.correct += attempt.correct;
        period.attempts += 1;
        period.users.add(attempt.user_id);

        if (!inCur) continue;

        const target = bucket(attempt.day);
        target.simulacro += attempt.answered;
        target.keyed += attempt.answered;
        target.correct += attempt.correct;
        target.attempts += 1;
        target.users.add(attempt.user_id);

        for (const result of attempt.results) {
            const area = areaRow(resolveArea(catalog, { area: result.area }));
            area.answered += result.correct + result.incorrect;
            area.keyed += result.correct + result.incorrect;
            area.correct += result.correct;
            area.users.add(attempt.user_id);
        }

        const stats = touch(attempt.user_id, attempt.day);
        stats.answered += attempt.answered;
        stats.keyed += attempt.answered;
        stats.correct += attempt.correct;
    }

    for (const practice of practices) {
        const at = toDate(practice?.created_at);
        const user = practice?.user_id ? String(practice.user_id) : null;
        if (!at || !user) continue;

        if (inWindow(at, range.from, range.to)) {
            cur.practices += 1;
            cur.users.add(user);
            bucket(dayKeyOf(at)).users.add(user);
            touch(user, dayKeyOf(at));
        } else if (inWindow(at, prevRange.from, prevRange.to)) {
            prev.practices += 1;
            prev.users.add(user);
        }
    }

    const series = axis.keys.map((key) => buckets.get(key) ?? { ...emptyTotals(), attempts: 0, users: new Set() });

    const areas = [...byArea.values()]
        .map((area) => ({
            key: area.key,
            name: area.name,
            slug: area.slug,
            answered: area.answered,
            keyed: area.keyed,
            correct: area.correct,
            accuracy: pct(area.correct, area.keyed),
            users: area.users.size,
            hardest: false,
        }))
        .sort((a, b) => {
            if ((a.key === NO_AREA.key) !== (b.key === NO_AREA.key)) return a.key === NO_AREA.key ? 1 : -1;
            return b.answered - a.answered || a.name.localeCompare(b.name, 'es');
        });

    const hardest = pickWeakest(areas, ADMIN_WEAK_AREA_MIN_KEYED, (a) => a.keyed, (a) => a.accuracy, (a) => a.answered);
    if (hardest) hardest.hardest = true;

    return {
        axis,
        cur: finishPeriod(cur),
        prev: finishPeriod(prev),
        compare: compareTotals(finishPeriod(cur), finishPeriod(prev)),
        series: {
            practice: series.map((row) => row.practice),
            simulacro: series.map((row) => row.simulacro),
            active: series.map((row) => row.users.size),
            accuracy: series.map((row) => pct(row.correct, row.keyed)),
            attempts: series.map((row) => row.attempts),
        },
        userStats,
        curUsers: cur.users,
        prevUsers: prev.users,
        areas,
    };
};

/**
 * Constancia de la poblacion: en cuantos dias distintos practico cada
 * postulante activo, la media, y cuantos de los activos del periodo anterior
 * volvieron en este.
 */
export const activeDaysDistribution = (userStats = new Map(), prevUsers = new Set()) => {
    const counts = [...userStats.values()].map((stats) => stats.days.size).filter((days) => days > 0);
    const total = counts.length;

    const buckets = ACTIVE_DAY_BUCKETS.map((bucket) => {
        const value = counts.filter((days) => days >= bucket.min && days <= bucket.max).length;
        return { label: bucket.label, value, pct: pct(value, total), bar: total > 0 ? Math.round((value / total) * 100) : 0 };
    });

    let returning = 0;
    for (const user of prevUsers) if (userStats.has(user)) returning += 1;

    return {
        buckets,
        users: total,
        mean: total > 0 ? Math.round((counts.reduce((acc, days) => acc + days, 0) / total) * 10) / 10 : null,
        returning,
        returning_pct: pct(returning, prevUsers.size),
    };
};

/** Postulantes con mas preguntas en el rango (desempate: mas dias activos). */
export const topUsers = (userStats = new Map(), limit = 20) => [...userStats.entries()]
    .map(([id, stats]) => ({
        user_id: id,
        answered: stats.answered,
        accuracy: pct(stats.correct, stats.keyed),
        active_days: stats.days.size,
        last_day: stats.last_day,
    }))
    .filter((row) => row.answered > 0)
    .sort((a, b) => b.answered - a.answered || b.active_days - a.active_days || (b.last_day ?? '').localeCompare(a.last_day ?? ''))
    .slice(0, limit);

// --- Presentacion -----------------------------------------------------------

/**
 * Vistas del grafico que lee /js/progress/charts.js. Solo numeros y etiquetas
 * generadas aqui: van crudas dentro de un <script> (ver toScriptJson). `color`
 * es un token de Bootstrap que el cliente lee de las variables CSS, asi el
 * grafico sigue al tema claro u oscuro.
 */
export const countView = ({ unit, labels, series, one, many, stacked = false }) => ({
    unit, labels, type: 'bar', format: 'count', stacked, one, many, series,
});

export const pctView = ({ unit, labels, name, data, color = 'primary' }) => ({
    unit, labels, type: 'line', format: 'pct', stacked: false, series: [{ name, color, data }],
});

/** Barras apiladas de preguntas por fuente. */
export const answeredView = (unit, { labels, practice, simulacro }) => countView({
    unit,
    labels,
    stacked: true,
    one: 'pregunta',
    many: 'preguntas',
    series: [
        { name: 'Exámenes y prácticas', color: 'primary', data: practice },
        { name: 'Simulacros', color: 'success', data: simulacro },
    ],
});

/** '68%' / '68,5%' o '—' sin base. */
export const pctLabel = (value) => (value === null || value === undefined ? '—' : `${value.toLocaleString('es-PE')}%`);

/** '+12%' / '−5%' / '0%'. */
export const signedLabel = (value, suffix = '%') => {
    if (value === null || value === undefined) return null;
    const abs = Math.abs(value).toLocaleString('es-PE');
    if (value > 0) return `+${abs}${suffix}`;
    if (value < 0) return `−${abs}${suffix}`;
    return `0${suffix}`;
};

/** Etiqueta de dia 'YYYY-MM-DD' -> '12 Set' (con el anio si no es el actual). */
export const dayKeyLabel = (key, now = new Date()) => {
    if (!key) return '—';
    const [y, m, d] = key.split('-').map(Number);
    return `${dayLabel({ m: m - 1, d })}${y !== limaParts(now).y ? ` ${y}` : ''}`;
};
