import AdmissionEventModel from '#Models/admission_event_model.js';
import AdmissionSourceModel from '#Models/admission_source_model.js';
import InstitutionModel from '#Models/institution_model.js';
import { EVENT_KINDS, EVENT_KIND_LABELS } from '#Schemas/admission_event_schema.js';
import { buildIcs, countdown, httpUrl, upcoming } from '#Libs/admission_calendar.js';
import { DAY_MS, dayKeyOf } from '#Libs/lima_time.js';

// Calendario publico de admision (antes admission.controllers.js del monolito).

// Se mira un mes hacia atras para que el calendario no aparezca vacio los primeros dias de un mes.
const HORIZON_PAST_DAYS = 31;
const NEXT_LIMIT = 12;
const EVENTS_LIMIT = 500;

const label = (institution) => institution?.abrev || institution?.name || '';

const readFilters = ({ institucion, tipo }, validIds) => ({
    institutionId: typeof institucion === 'string' && validIds.has(institucion) ? institucion : '',
    kinds: typeof tipo === 'string' ? tipo.split(',').filter((kind) => EVENT_KINDS.includes(kind)) : [],
});

/** Instituciones activas con al menos una fecha publicada vigente. */
const institutionsWithEvents = async () => {
    const ids = await AdmissionEventModel.distinct('institution_id', {
        status: 'published',
        end_date: { $gte: new Date(Date.now() - HORIZON_PAST_DAYS * DAY_MS) },
    });
    return InstitutionModel.find({ _id: { $in: ids }, state: true }, { name: 1, abrev: 1, image: 1 }).sort({ name: 1 }).lean().exec();
};

const listEvents = ({ institutionId, kinds } = {}) => {
    const filter = { status: 'published', end_date: { $gte: new Date(Date.now() - HORIZON_PAST_DAYS * DAY_MS) } };
    if (institutionId) filter.institution_id = institutionId;
    if (kinds?.length) filter.kind = { $in: kinds };
    return AdmissionEventModel.find(filter).sort({ start_date: 1 }).limit(EVENTS_LIMIT).lean().exec();
};

/**
 * Fuentes activas: `official` rotula el enlace y `fallback` da, por institucion, la primera oficial
 * (la usa un evento sin URL propia).
 */
const loadSources = async (institutionIds) => {
    const sources = await AdmissionSourceModel
        .find({ institution_id: { $in: institutionIds }, active: true }, { institution_id: 1, url: 1, label: 1, official: 1 })
        .sort({ created_at: 1 }).lean().exec();

    const official = new Map();
    const fallback = new Map();
    const list = [];
    for (const source of sources) {
        const url = httpUrl(source.url);
        if (!url) continue;
        official.set(String(source._id), Boolean(source.official));
        if (!source.official) continue;
        if (!fallback.has(source.institution_id)) fallback.set(source.institution_id, url);
        list.push({ institution_id: source.institution_id, url, label: source.label || '' });
    }
    return { official, fallback, list };
};

// Enlace de un evento: el que puso un admin, el de su fuente o la fuente oficial de la institucion.
const eventLink = (event, sources) => {
    const own = httpUrl(event.url);
    if (own) return { url: own, official: true };
    const fromSource = httpUrl(event.source_url);
    if (fromSource) return { url: fromSource, official: sources.official.get(String(event.source_id)) ?? false };
    const fallback = sources.fallback.get(event.institution_id);
    return fallback ? { url: fallback, official: true } : { url: '', official: false };
};

const serializeEvent = (event, institution, sources) => {
    const link = eventLink(event, sources);
    return {
        id: event._id,
        institution_id: event.institution_id,
        institution: label(institution),
        institution_name: institution?.name ?? '',
        title: event.title,
        kind: event.kind,
        kind_label: EVENT_KIND_LABELS[event.kind] ?? event.kind,
        modality: event.modality || '',
        period: event.period || '',
        notes: event.notes || '',
        url: link.url,
        url_official: link.official,
        verified_at: event.verified_at ?? null,
        // Dias de Lima 'YYYY-MM-DD' (ambos inclusivos), sin horas: el cliente no debe convertir zonas.
        start: dayKeyOf(new Date(event.start_date)),
        end: dayKeyOf(new Date(event.end_date)),
    };
};

export const getCalendar = async (query, now = new Date()) => {
    const institutions = await institutionsWithEvents();
    const byId = new Map(institutions.map((institution) => [String(institution._id), institution]));
    const { institutionId, kinds } = readFilters(query, new Set(byId.keys()));

    const visible = (await listEvents()).filter((event) => byId.has(String(event.institution_id)));
    const sources = await loadSources([...byId.keys()]);
    const events = visible.map((event) => serializeEvent(event, byId.get(String(event.institution_id)), sources));

    // Las proximas siguen el mismo filtro que la URL; el calendario trae todo y el cliente filtra.
    const filtered = upcoming(
        visible.filter((event) => (!institutionId || event.institution_id === institutionId) && (!kinds.length || kinds.includes(event.kind))),
        { now },
    );
    const next = filtered.slice(0, NEXT_LIMIT).map((event) => ({
        ...serializeEvent(event, byId.get(String(event.institution_id)), sources),
        ...countdown(event, now),
    }));

    return {
        institutions: institutions.map((institution) => ({ id: String(institution._id), label: label(institution), name: institution.name })),
        kinds: EVENT_KINDS.map((value) => ({ value, label: EVENT_KIND_LABELS[value] })),
        selected: { institution_id: institutionId || null, kinds },
        events,
        next,
        next_more: Math.max(filtered.length - next.length, 0),
        sources: institutions
            .map((institution) => ({
                institution_id: String(institution._id),
                label: label(institution),
                name: institution.name,
                sources: sources.list.filter((source) => source.institution_id === String(institution._id)),
            }))
            .filter((group) => group.sources.length),
    };
};

export const getCalendarIcs = async (query) => {
    const institutions = await institutionsWithEvents();
    const byId = new Map(institutions.map((institution) => [String(institution._id), institution]));
    const { institutionId, kinds } = readFilters(query, new Set(byId.keys()));

    const events = (await listEvents({ institutionId, kinds })).filter((event) => byId.has(String(event.institution_id)));
    const selected = byId.get(institutionId);
    const content = buildIcs(events, {
        name: selected ? `Admisión ${label(selected)}` : 'Calendario de admisión Eduteka',
        institutionNames: Object.fromEntries([...byId].map(([id, institution]) => [id, label(institution)])),
    });
    const filename = selected ? `admision-${label(selected).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ics` : 'admision-eduteka.ics';
    return { content, filename };
};
