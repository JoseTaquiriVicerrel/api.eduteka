/**
 * Fechas en hora de Lima para los paneles de metricas.
 *
 * Extraido de #Services/teacher_beta_stats.service.js, que las sigue
 * re-exportando con los mismos nombres: el panel de beta docentes y el de
 * progreso tienen que agrupar los dias exactamente igual.
 *
 * Peru no aplica horario de verano: el offset es fijo. Mismo criterio que el
 * panel de ingresos (#Controllers/admin/income.admin.controllers.js).
 */

export const TZ = 'America/Lima';
export const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 365;
// A partir de aqui una barra por dia deja de leerse: se agrupa por semana ISO.
export const WEEKLY_FROM_DAYS = 92;

export const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];

export const limaParts = (date) => {
    const lima = new Date(date.getTime() - TZ_OFFSET_MS);
    return { y: lima.getUTCFullYear(), m: lima.getUTCMonth(), d: lima.getUTCDate() };
};

/** Instante UTC de las 00:00 de Lima del dia indicado. */
export const limaDate = (y, m, d) => new Date(Date.UTC(y, m, d) + TZ_OFFSET_MS);

export const startOfDay = (date) => {
    const { y, m, d } = limaParts(date);
    return limaDate(y, m, d);
};

/** Parsea 'YYYY-MM-DD' del query en hora de Lima. null si no es valida. */
export const parseQueryDate = (value, endOfDay = false) => {
    if (typeof value !== 'string') return null;

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;

    const date = limaDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

    // Rechaza 2025-02-31, que Date normalizaria en silencio a marzo.
    const { y, m, d } = limaParts(date);
    if (y !== Number(match[1]) || m !== Number(match[2]) - 1 || d !== Number(match[3])) return null;

    return endOfDay ? new Date(date.getTime() + DAY_MS - 1) : date;
};

/** 'YYYY-MM-DD' en hora de Lima, para repoblar los <input type="date">. */
export const toInputDate = (date) => new Date(date.getTime() - TZ_OFFSET_MS).toISOString().slice(0, 10);

/** Las 00:00 de Lima de `days - 1` dias antes del dia de `date`. */
export const daysBefore = (date, days) => new Date(startOfDay(date).getTime() - (days - 1) * DAY_MS);

/**
 * Rango pedido en el query. Ante una entrada invalida cae a los ultimos
 * DEFAULT_RANGE_DAYS dias en vez de romper la vista, y recorta por el extremo
 * antiguo a MAX_RANGE_DAYS.
 *
 * La granularidad sale de aqui y no de la vista: los KPIs y la serie tienen que
 * describir exactamente el mismo intervalo.
 */
export const resolveRange = (query = {}, now = new Date()) => {
    let from = parseQueryDate(query.from);
    let to = parseQueryDate(query.to, true);

    if (!to || to > now) to = now;
    if (!from || from > to) from = daysBefore(to, DEFAULT_RANGE_DAYS);

    const earliest = daysBefore(to, MAX_RANGE_DAYS);
    if (from < earliest) from = earliest;

    from = startOfDay(from);
    const days = Math.round((startOfDay(to).getTime() - from.getTime()) / DAY_MS) + 1;

    return { from, to, days, unit: days > WEEKLY_FROM_DAYS ? 'week' : 'day' };
};

export const dayKey = ({ y, m, d }) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Clave de semana ISO ('2026-W37'), la misma que produce `%G-W%V` en
 * $dateToString. Tienen que coincidir caracter a caracter: si no, las filas de
 * la base no encuentran su barra y la serie sale en cero.
 */
export const isoWeekKey = ({ y, m, d }) => {
    const date = new Date(Date.UTC(y, m, d));
    const weekday = date.getUTCDay() || 7;
    // El jueves de esa semana decide a que anio ISO pertenece.
    date.setUTCDate(date.getUTCDate() + 4 - weekday);
    const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

export const bucketKey = (date, unit) => (unit === 'week' ? isoWeekKey(limaParts(date)) : dayKey(limaParts(date)));

/** 'YYYY-MM-DD' de Lima de un instante. */
export const dayKeyOf = (date) => dayKey(limaParts(date));

/** Partes de una clave 'YYYY-MM-DD'. */
export const partsFromDayKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return { y, m: m - 1, d };
};

/** Suma `n` dias de calendario a una clave de dia (sin pasar por la hora). */
export const shiftDayKey = (key, n) => {
    const { y, m, d } = partsFromDayKey(key);
    const date = new Date(Date.UTC(y, m, d + n));
    return dayKey({ y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() });
};

export const weekKeyOfDayKey = (key) => isoWeekKey(partsFromDayKey(key));

/** 1 (lunes) .. 7 (domingo), en hora de Lima. */
export const isoWeekday = (date) => {
    const { y, m, d } = limaParts(date);
    return new Date(Date.UTC(y, m, d)).getUTCDay() || 7;
};

/** Lunes 00:00 de Lima de la semana ISO de `date`. */
export const startOfIsoWeek = (date) => new Date(startOfDay(date).getTime() - (isoWeekday(date) - 1) * DAY_MS);

/** '12 Set' */
export const dayLabel = ({ m, d }) => `${d} ${MONTH_NAMES[m]}`;

/**
 * Agrupacion por dia de Lima para los $group. Solo sobre campos que son Date
 * en todos los documentos: con un string o un null, $dateToString revienta.
 */
export const limaDayExpr = (field = '$created_at') => ({
    $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ },
});

/**
 * Eje completo del rango. Se construye entero a proposito: los dias sin
 * actividad tienen que salir en cero, si no el grafico junta dias no contiguos
 * y la tendencia miente. En semanal la etiqueta es el primer dia del rango que
 * cae en esa semana, asi que la primera puede ser parcial.
 */
export const buildAxis = ({ from, to, unit }) => {
    const keys = [];
    const labels = [];

    for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
        const parts = limaParts(new Date(t));
        const key = unit === 'week' ? isoWeekKey(parts) : dayKey(parts);
        if (keys[keys.length - 1] === key) continue;

        keys.push(key);
        labels.push(dayLabel(parts));
    }

    return { keys, labels };
};

/** Serie alineada al eje. Las filas fuera del eje se ignoran. */
export const fillSeries = (keys, rows, field = 'count') => {
    const byKey = new Map(rows.map((row) => [row._id, row[field] ?? 0]));
    return keys.map((key) => byKey.get(key) ?? 0);
};

export const sum = (values) => values.reduce((acc, value) => acc + value, 0);

/** Porcentaje con un decimal, o null si no hay base (la vista pinta un guion). */
export const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
