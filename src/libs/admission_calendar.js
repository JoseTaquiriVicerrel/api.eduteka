import { DAY_MS, TZ, dayKeyOf, limaParts, startOfDay } from '#Libs/lima_time.js';

// Calendario de admision: funciones puras (reciben los eventos ya leidos) para probar los bordes de dia
// en hora de Lima sin base de datos. Misma logica que src/services/admission/queries.js del monolito.

const MONTH_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const dayLabelOf = (date, withYear = true) => {
    const { y, m, d } = limaParts(new Date(date));
    return `${d} ${MONTH_LONG[m]}${withYear ? ` ${y}` : ''}`;
};

/** Dias de calendario (Lima) que faltan hasta `date`; 0 es hoy, negativo ya paso. */
export const daysUntil = (date, now = new Date()) => Math.round((startOfDay(new Date(date)).getTime() - startOfDay(now).getTime()) / DAY_MS);

/** '13 diciembre 2026' o '1 – 30 noviembre 2026' (en hora de Lima). */
export const formatRange = (start, end) => {
    const a = limaParts(new Date(start));
    const b = limaParts(new Date(end));

    if (a.y === b.y && a.m === b.m && a.d === b.d) return dayLabelOf(start);
    if (a.y === b.y && a.m === b.m) return `${a.d} – ${b.d} ${MONTH_LONG[b.m]} ${b.y}`;
    if (a.y === b.y) return `${dayLabelOf(start, false)} – ${dayLabelOf(end)}`;
    return `${dayLabelOf(start)} – ${dayLabelOf(end)}`;
};

/** Solo http(s): las URLs vienen de paginas externas y se pintan como enlace. */
export const httpUrl = (value) => (typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : '');

/** Cuenta regresiva de un evento (rotulos y urgencia). */
export const countdown = (event, now = new Date()) => {
    const toStart = daysUntil(event.start_date, now);
    const toEnd = daysUntil(event.end_date, now);
    const ongoing = toStart <= 0 && toEnd >= 0;
    return {
        range_label: formatRange(event.start_date, event.end_date),
        days_label: ongoing
            ? (toEnd === 0 ? 'Termina hoy' : `En curso · termina en ${toEnd} día${toEnd === 1 ? '' : 's'}`)
            : (toStart === 0 ? 'Hoy' : toStart === 1 ? 'Mañana' : `Faltan ${toStart} días`),
        urgent: toStart <= 7 || ongoing,
    };
};

/** Los eventos vigentes (el dia de hoy cuenta como vigente), del mas cercano al mas lejano. */
export const upcoming = (events, { now = new Date(), limit = 500 } = {}) => {
    const today = startOfDay(now).getTime();
    return events
        .filter((event) => new Date(event.end_date).getTime() >= today)
        .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
        .slice(0, limit);
};

const icsEscape = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

// Las lineas de un .ics no pasan de 75 octetos: se pliegan con CRLF + espacio.
const fold = (line) => {
    const chunks = [];
    let rest = line;
    while (Buffer.byteLength(rest) > 74) {
        let cut = 74;
        while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--;
        chunks.push(rest.slice(0, cut));
        rest = ` ${rest.slice(cut)}`;
    }
    chunks.push(rest);
    return chunks.join('\r\n');
};

const icsDate = (date) => dayKeyOf(new Date(date)).replace(/-/g, '');

/** Archivo .ics con eventos de todo el dia. DTEND es EXCLUSIVO: el ultimo dia + 1. */
export const buildIcs = (events, { name = 'Calendario de admisión', institutionNames = {}, now = new Date() } = {}) => {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Eduteka//Calendario de admision//ES',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${icsEscape(name)}`,
        `X-WR-TIMEZONE:${TZ}`,
    ];

    for (const event of events) {
        const endExclusive = new Date(new Date(event.end_date).getTime() + DAY_MS);
        const institution = institutionNames[event.institution_id];
        const link = httpUrl(event.url) || httpUrl(event.source_url);
        const description = [
            institution ?? '',
            event.modality ? `Modalidad: ${event.modality}` : '',
            event.period ? `Proceso: ${event.period}` : '',
            event.notes,
            link ? `Más información: ${link}` : '',
            'Confirma siempre las fechas en la web oficial de la institución.',
        ].filter(Boolean).join('\n');

        lines.push(
            'BEGIN:VEVENT',
            `UID:${event._id}@eduteka.pe`,
            `DTSTAMP:${stamp}`,
            `DTSTART;VALUE=DATE:${icsDate(event.start_date)}`,
            `DTEND;VALUE=DATE:${icsDate(endExclusive)}`,
            `SUMMARY:${icsEscape(institution ? `${event.title} · ${institution}` : event.title)}`,
            `DESCRIPTION:${icsEscape(description)}`,
        );
        if (link) lines.push(`URL:${link}`);
        lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
};
