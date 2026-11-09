import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { seedCatalog } from './helpers/seed.js';
import { buildIcs, countdown, formatRange, upcoming } from '../src/libs/admission_calendar.js';
import { limaDate } from '../src/libs/lima_time.js';

// 10 de noviembre de 2026, mediodia en Lima.
const NOW = new Date(Date.UTC(2026, 10, 10, 17, 0));
const at = (y, m, d) => limaDate(y, m - 1, d);

describe('calendario de admision: funciones puras', () => {
    it('formatRange cubre un dia, un mes, un año y varios años', () => {
        assert.equal(formatRange(at(2026, 12, 13), at(2026, 12, 13)), '13 diciembre 2026');
        assert.equal(formatRange(at(2026, 11, 1), at(2026, 11, 30)), '1 – 30 noviembre 2026');
        assert.equal(formatRange(at(2026, 11, 20), at(2026, 12, 5)), '20 noviembre – 5 diciembre 2026');
        assert.equal(formatRange(at(2026, 12, 20), at(2027, 1, 5)), '20 diciembre 2026 – 5 enero 2027');
    });

    it('countdown: hoy, mañana, en curso y urgencia', () => {
        // Un evento de un solo dia que es hoy ya esta "en curso" (igual que el monolito).
        assert.equal(countdown({ start_date: at(2026, 11, 10), end_date: at(2026, 11, 10) }, NOW).days_label, 'Termina hoy');
        assert.equal(countdown({ start_date: at(2026, 11, 10), end_date: at(2026, 11, 12) }, NOW).urgent, true);
        assert.equal(countdown({ start_date: at(2026, 11, 11), end_date: at(2026, 11, 11) }, NOW).days_label, 'Mañana');
        const far = countdown({ start_date: at(2026, 12, 25), end_date: at(2026, 12, 26) }, NOW);
        assert.equal(far.days_label, 'Faltan 45 días');
        assert.equal(far.urgent, false);
        const ongoing = countdown({ start_date: at(2026, 11, 1), end_date: at(2026, 11, 12) }, NOW);
        assert.equal(ongoing.days_label, 'En curso · termina en 2 días');
        assert.equal(ongoing.urgent, true);
        assert.equal(countdown({ start_date: at(2026, 11, 1), end_date: at(2026, 11, 10) }, NOW).days_label, 'Termina hoy');
    });

    it('upcoming descarta lo terminado, deja lo de hoy y ordena', () => {
        const events = [
            { _id: 'c', start_date: at(2026, 12, 1), end_date: at(2026, 12, 1) },
            { _id: 'old', start_date: at(2026, 11, 1), end_date: at(2026, 11, 9) },
            { _id: 'today', start_date: at(2026, 11, 10), end_date: at(2026, 11, 10) },
        ];
        assert.deepEqual(upcoming(events, { now: NOW }).map((event) => event._id), ['today', 'c']);
    });

    it('buildIcs: DTEND exclusivo, escapes y plegado de lineas', () => {
        const ics = buildIcs(
            [{ _id: 'e1', institution_id: 'i1', title: 'Examen, fase 1; final', start_date: at(2026, 12, 13), end_date: at(2026, 12, 14), notes: 'x'.repeat(200), url: 'https://uni.pe' }],
            { institutionNames: { i1: 'UNI' }, now: NOW },
        );
        assert.match(ics, /DTSTART;VALUE=DATE:20261213\r\n/);
        assert.match(ics, /DTEND;VALUE=DATE:20261215\r\n/);
        assert.match(ics, /SUMMARY:Examen\\, fase 1\\; final · UNI/);
        assert.match(ics, /URL:https:\/\/uni\.pe\r\n/);
        for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `linea larga: ${line}`);
    });
});

describe('GET /admision/calendario', () => {
    let ctx;
    const day = (offset) => new Date(Date.now() + offset * 86_400_000);

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        const db = ctx.mongoose.connection.db;
        await db.collection('institutions').insertOne({ _id: 'inst-off', name: 'Inactiva', abrev: 'OFF', state: false });
        const base = { status: 'published', all_day: true, origin: 'manual' };
        await db.collection('admissionevents').insertMany([
            { ...base, _id: 'ev1', institution_id: 'inst-unmsm', title: 'Inscripción', kind: 'inscripcion', start_date: day(3), end_date: day(10), fingerprint: 'a' },
            { ...base, _id: 'ev2', institution_id: 'inst-unmsm', title: 'Examen', kind: 'examen', start_date: day(30), end_date: day(30), fingerprint: 'b', url: 'https://sm.pe/examen' },
            { ...base, _id: 'ev3', institution_id: 'inst-unmsm', title: 'Pendiente', kind: 'otro', status: 'pending_review', start_date: day(5), end_date: day(5), fingerprint: 'c' },
            { ...base, _id: 'ev4', institution_id: 'inst-unmsm', title: 'Muy vieja', kind: 'examen', start_date: day(-90), end_date: day(-80), fingerprint: 'd' },
            { ...base, _id: 'ev5', institution_id: 'inst-off', title: 'De institución inactiva', kind: 'examen', start_date: day(4), end_date: day(4), fingerprint: 'e' },
        ]);
        await db.collection('admissionsources').insertMany([
            { _id: 's1', institution_id: 'inst-unmsm', url: 'https://sm.pe/admision', label: 'Admisión', official: true, active: true },
            { _id: 's2', institution_id: 'inst-unmsm', url: 'javascript:alert(1)', official: true, active: true },
            { _id: 's3', institution_id: 'inst-unmsm', url: 'https://otro.pe', official: false, active: true },
        ]);
    });
    after(() => ctx.stop());

    const get = (query = '') => request(ctx.app).get(`/api/v1/admision/calendario${query}`);

    it('publica solo lo publicado, vigente y de instituciones activas', async () => {
        const { data } = (await get().expect(200)).body;
        assert.deepEqual(data.events.map((event) => event.id), ['ev1', 'ev2']);
        assert.deepEqual(data.institutions.map((institution) => institution.id), ['inst-unmsm']);
        assert.equal(data.events[0].url, 'https://sm.pe/admision', 'sin URL propia usa la fuente oficial');
        assert.equal(data.events[1].url, 'https://sm.pe/examen');
        assert.match(data.events[0].start, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('solo expone fuentes oficiales con http(s)', async () => {
        const { data } = (await get().expect(200)).body;
        assert.deepEqual(data.sources.map((group) => group.sources.map((source) => source.url)), [['https://sm.pe/admision']]);
    });

    it('el filtro por tipo afecta a `next` pero no al calendario', async () => {
        const { data } = (await get('?tipo=examen,inventado').expect(200)).body;
        assert.deepEqual(data.next.map((event) => event.id), ['ev2']);
        assert.equal(data.events.length, 2);
        assert.deepEqual(data.selected.kinds, ['examen']);
    });

    it('una institución desconocida se ignora', async () => {
        const { data } = (await get('?institucion=nada').expect(200)).body;
        assert.equal(data.selected.institution_id, null);
        assert.equal(data.next.length, 2);
    });

    it('el .ics se descarga con su tipo y nombre', async () => {
        const res = await request(ctx.app).get('/api/v1/admision/calendario.ics?institucion=inst-unmsm').expect(200);
        assert.match(res.headers['content-type'], /text\/calendar/);
        assert.match(res.headers['content-disposition'], /admision-sm\.ics/);
        assert.match(res.text, /SUMMARY:Inscripción · SM/);
        assert.ok(!res.text.includes('Pendiente'));
    });
});
