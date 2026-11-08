import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedSimulacra } from './helpers/seed.js';

const API = '/api/v1/simulacros';
const minute = 60_000;

// Simulacros programados (start_date y end_date definidos) con fechas relativas a "ahora".
// `automatic` va en false a proposito: no decide nada.
describe('simulacros programados: estado y filtro ?status=', () => {
    let ctx;

    const sched = (slug, closeMin, startMin, endMin, extra = {}) => {
        const now = Date.now();
        return {
            _id: `s-${slug}`, slug, title: `Programado ${slug}`, verified: true, state: true, automatic: false, finished: false,
            general: true, duration: 3, price: 0, for_register: true,
            register_close_date: new Date(now + closeMin * minute),
            start_date: new Date(now + startMin * minute),
            end_date: new Date(now + endMin * minute),
            created_at: new Date(now), ...extra,
        };
    };

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
        await ctx.mongoose.connection.db.collection('simulacrums').insertMany([
            sched('prog-inscripcion', 5, 10, 70),
            sched('prog-espera', -5, 10, 70),
            sched('prog-vivo', -20, -10, 50),
            sched('prog-terminado', -90, -60, -30),
            sched('prog-cerrado-admin', -20, -10, 50, { finished: true }),
        ]);
    });
    after(() => ctx.stop());

    const slugs = async (query) => {
        const res = await request(ctx.app).get(`${API}?${query}&limit=50`).expect(200);
        return res.body.data.map((item) => item.slug);
    };
    const statuses = async () => {
        const res = await request(ctx.app).get(`${API}?limit=50`).expect(200);
        return Object.fromEntries(res.body.data.map((item) => [item.slug, item.status]));
    };

    it('cada programado aparece solo en el filtro de su fase', async () => {
        const upcoming = await slugs('status=upcoming');
        const live = await slugs('status=live');
        const finished = await slugs('status=finished');

        for (const slug of ['prog-inscripcion', 'prog-espera']) {
            assert.ok(upcoming.includes(slug), `${slug} en upcoming`);
            assert.ok(!live.includes(slug) && !finished.includes(slug), `${slug} solo en upcoming`);
        }
        assert.ok(live.includes('prog-vivo'));
        assert.ok(!upcoming.includes('prog-vivo') && !finished.includes('prog-vivo'));
        for (const slug of ['prog-terminado', 'prog-cerrado-admin']) {
            assert.ok(finished.includes(slug), `${slug} en finished`);
            assert.ok(!upcoming.includes(slug) && !live.includes(slug), `${slug} solo en finished`);
        }
    });

    it('el campo status de la lista coincide con el filtro', async () => {
        const status = await statuses();
        assert.equal(status['prog-inscripcion'], 'upcoming');
        assert.equal(status['prog-espera'], 'upcoming');
        assert.equal(status['prog-vivo'], 'live');
        assert.equal(status['prog-terminado'], 'finished');
        assert.equal(status['prog-cerrado-admin'], 'finished');
    });

    it('los no programados conservan su estado de siempre', async () => {
        const status = await statuses();
        assert.equal(status['simulacro-general'], 'live');
        assert.equal(status['evento-proximo'], 'upcoming');
        assert.equal(status['evento-vivo'], 'live');
        assert.equal(status['evento-cerrado'], 'finished');
        assert.equal(status['cerrado-admin'], 'finished');
    });

    describe('lectura: schedule, public_results y absent', () => {
        const detail = (slug, user) => request(ctx.app).get(`${API}/${slug}`).set(user ? bearer(user) : {});

        it('la ficha de un programado trae schedule con fechas ISO y fase', async () => {
            const { body } = await detail('prog-inscripcion').expect(200);
            const { schedule } = body.data;
            assert.equal(schedule.phase, 'registration');
            assert.equal(schedule.registration_open, true);
            for (const key of ['register_close_date', 'start_date', 'end_date', 'results_at']) {
                assert.match(schedule[key], /^\d{4}-\d{2}-\d{2}T.*Z$/, key);
            }
            // Sin results_public_at, los resultados salen al terminar la ventana.
            assert.equal(schedule.results_at, schedule.end_date);
            assert.equal(schedule.results_published, false);
            assert.equal(body.data.status, 'upcoming');
            assert.equal(body.data.start_date, schedule.start_date);
        });

        it('las fases waiting y live se reflejan en schedule', async () => {
            assert.equal((await detail('prog-espera')).body.data.schedule.phase, 'waiting');
            assert.equal((await detail('prog-espera')).body.data.schedule.registration_open, false);
            assert.equal((await detail('prog-vivo')).body.data.schedule.phase, 'live');
            assert.equal((await detail('prog-terminado')).body.data.schedule.phase, 'finished');
        });

        it('la lista trae schedule en cada programado, con register_close_date (la proyeccion del listado)', async () => {
            const res = await request(ctx.app).get(`${API}?limit=50`).expect(200);
            const row = res.body.data.find((item) => item.slug === 'prog-inscripcion');
            assert.equal(row.schedule.phase, 'registration');
            assert.ok(row.schedule.register_close_date);
            assert.notEqual(row.schedule.register_close_date, row.schedule.start_date);
            assert.match(res.body.meta.server_time, /^\d{4}-\d{2}-\d{2}T/);
        });

        it('results_public_at define results_at', async () => {
            const at = new Date(Date.now() + 100 * minute);
            await ctx.mongoose.connection.db.collection('simulacrums').insertOne(sched('prog-resultados', 5, 10, 70, { results_public_at: at }));
            const { body } = await detail('prog-resultados').expect(200);
            assert.equal(body.data.schedule.results_at, at.toISOString());
        });

        it('public_results sin definir en un programado es false; true solo si esta publicado', async () => {
            const sinCampo = (await detail('prog-vivo')).body.data;
            assert.equal(sinCampo.public_results, false);
            assert.equal(sinCampo.schedule.results_published, false);

            await ctx.mongoose.connection.db.collection('simulacrums').insertOne(sched('prog-publicado', -90, -60, -30, { public_results: true }));
            const publicado = (await detail('prog-publicado')).body.data;
            assert.equal(publicado.public_results, true);
            assert.equal(publicado.schedule.results_published, true);

            // La regla historica del resto no cambia: el campo sin definir sigue siendo publico.
            await ctx.mongoose.connection.db.collection('simulacrums').insertOne({ ...sched('bajo-demanda-sin-campo', 0, 0, 0), start_date: null, end_date: null, register_close_date: null });
            assert.equal((await detail('bajo-demanda-sin-campo')).body.data.public_results, true);
        });

        it('un no programado trae schedule: null', async () => {
            for (const slug of ['simulacro-general', 'evento-vivo']) {
                const { body } = await detail(slug).expect(200);
                // evento-vivo tiene fechas: es programado aunque tambien sea automatic.
                if (slug === 'simulacro-general') assert.equal(body.data.schedule, null);
                else assert.equal(body.data.schedule.phase, 'live');
            }
        });

        it('enrollment.absent sale de ausent', async () => {
            const user = await createUser(ctx);
            const db = ctx.mongoose.connection.db.collection('usersimulacrums');
            await db.insertOne({
                _id: 'e-ausente', user_id: user.session.user.id, simulacrum_id: 's-prog-terminado', state: true, finished: false, ausent: true, attempt_number: 1,
            });
            const { body } = await detail('prog-terminado', user).expect(200);
            assert.equal(body.data.enrollment.absent, true);
            assert.equal(body.data.enrollment.state, 'finished');

            await db.insertOne({
                _id: 'e-normal', user_id: user.session.user.id, simulacrum_id: 's-prog-vivo', state: true, finished: false, attempt_number: 1,
            });
            assert.equal((await detail('prog-vivo', user).expect(200)).body.data.enrollment.absent, false);
        });
    });

    describe('POST /simulacros/:slug/inscribirme', () => {
        const person = { fullname: 'Ana Pérez López', dni: '12345678' };
        const sims = () => ctx.mongoose.connection.db.collection('simulacrums');
        const enroll = (slug, user) => request(ctx.app).post(`${API}/${slug}/inscribirme`).set(bearer(user)).send(person);
        const closed = async (slug) => {
            const res = await enroll(slug, await createUser(ctx)).expect(403);
            assert.equal(res.body.error.code, 'REGISTRATION_CLOSED');
            return res;
        };

        it('en la fase de inscripcion se inscribe (201)', async () => {
            await enroll('prog-inscripcion', await createUser(ctx)).expect(201);
        });

        it('en waiting, live o finished: 403 REGISTRATION_CLOSED', async () => {
            for (const slug of ['prog-espera', 'prog-vivo', 'prog-terminado', 'prog-cerrado-admin']) await closed(slug);
        });

        it('for_register:false lo bloquea aunque la ventana de inscripcion siga abierta', async () => {
            await sims().insertOne(sched('prog-sin-registro', 5, 10, 70, { for_register: false }));
            await closed('prog-sin-registro');
        });

        it('con el cierre posterior al inicio, durante live nadie se inscribe', async () => {
            await sims().insertOne(sched('prog-cierre-tardio', 30, -5, 60));
            await closed('prog-cierre-tardio');
        });

        it('no crea la inscripcion cuando esta cerrada', async () => {
            const user = await createUser(ctx);
            await enroll('prog-espera', user).expect(403);
            const rows = await ctx.mongoose.connection.db.collection('usersimulacrums')
                .countDocuments({ user_id: user.session.user.id, simulacrum_id: 's-prog-espera' });
            assert.equal(rows, 0);
        });

        it('sin for_register definido se permite, en programados y en bajo demanda', async () => {
            await sims().insertOne(sched('prog-sin-campo', 5, 10, 70));
            await sims().updateOne({ _id: 's-prog-sin-campo' }, { $unset: { for_register: '' } });
            await enroll('prog-sin-campo', await createUser(ctx)).expect(201);

            await sims().insertOne({ ...sched('bajo-demanda-libre', 0, 0, 0), start_date: null, end_date: null, register_close_date: null });
            await sims().updateOne({ _id: 's-bajo-demanda-libre' }, { $unset: { for_register: '' } });
            await enroll('bajo-demanda-libre', await createUser(ctx)).expect(201);
        });

        it('bajo demanda con for_register:false conserva su 403 FORBIDDEN', async () => {
            const res = await enroll('sin-inscripcion', await createUser(ctx)).expect(403);
            assert.equal(res.body.error.code, 'FORBIDDEN');
            assert.match(res.body.error.message, /plazo de inscripción/);
        });
    });

    // --- Rendir un programado: iniciar, guardar, finalizar -------------------------------------------
    describe('iniciar / respuestas / finalizar', () => {
        const sims = () => ctx.mongoose.connection.db.collection('simulacrums');
        const enrollments = () => ctx.mongoose.connection.db.collection('usersimulacrums');
        const call = (method, route, user, body) => request(ctx.app)[method](`${API}${route}`).set(bearer(user)).send(body);
        let counter = 0;

        /**
         * Programado con las preguntas de `simulacro-general`, ventana relativa a "ahora" y un inscrito aprobado
         * (se inserta directo: con la ventana en vivo la API ya no inscribe, contrato D8).
         */
        const scenario = async ({ startMin, endMin, sim = {}, enrollment = {} }) => {
            counter += 1;
            const slug = `rendir-${counter}`;
            const base = await sims().findOne({ _id: 's-simulacro-general' });
            const now = Date.now();
            await sims().insertOne({
                ...base, _id: `s-${slug}`, slug, automatic: false, finished: false, duration: 3, public_results: undefined,
                register_close_date: new Date(now + (startMin - 1) * minute),
                start_date: new Date(now + startMin * minute),
                end_date: new Date(now + endMin * minute),
                ...sim,
            });
            const user = await createUser(ctx);
            await enrollments().insertOne({
                _id: `u-${slug}`, user_id: user.session.user.id, simulacrum_id: `s-${slug}`, fullname: 'Ana Pérez', area: 'I',
                state: true, finished: false, attempt_number: 1, ...enrollment,
            });
            return { slug, user, id: `u-${slug}` };
        };
        const startOf = (slug, user) => call('post', `/${slug}/iniciar`, user);
        const seconds = (data) => (new Date(data.end_exam) - new Date(data.start_exam)) / 1000;

        it('entrar a tiempo: duracion completa, sin aviso de entrada tardia', async () => {
            const { slug, user } = await scenario({ startMin: -1, endMin: 9 });
            const { data } = (await startOf(slug, user).expect(200)).body;
            assert.equal(seconds(data), 180);
            assert.deepEqual(
                [data.window.allowed_seconds, data.window.duration_seconds, data.window.shortened],
                [180, 180, false],
            );
            assert.match(data.window.end_date, /Z$/);
        });

        it('entrar tarde (ventana 5 min, duracion 3, a los 3 min): end_exam = end_date y shortened', async () => {
            const { slug, user } = await scenario({ startMin: -3, endMin: 2 });
            const sim = await sims().findOne({ _id: `s-${slug}` });
            const { data } = (await startOf(slug, user).expect(200)).body;
            assert.equal(data.end_exam, sim.end_date.toISOString());
            assert.equal(data.window.shortened, true);
            assert.ok(Math.abs(data.window.allowed_seconds - 120) <= 2, `allowed_seconds=${data.window.allowed_seconds}`);
            assert.equal(data.window.duration_seconds, 180);
        });

        it('iniciar de nuevo el mismo intento devuelve el mismo end_exam y la misma ventana', async () => {
            const { slug, user } = await scenario({ startMin: -3, endMin: 2 });
            const first = (await startOf(slug, user).expect(200)).body.data;
            const second = (await startOf(slug, user).expect(200)).body.data;
            assert.equal(second.start_exam, first.start_exam);
            assert.equal(second.end_exam, first.end_exam);
            assert.deepEqual(second.window, first.window);
        });

        it('antes del inicio: 403 NOT_STARTED; despues del fin: 403 WINDOW_ENDED', async () => {
            const early = await scenario({ startMin: 10, endMin: 70 });
            assert.equal((await startOf(early.slug, early.user).expect(403)).body.error.code, 'NOT_STARTED');

            const late = await scenario({ startMin: -60, endMin: -5 });
            assert.equal((await startOf(late.slug, late.user).expect(403)).body.error.code, 'WINDOW_ENDED');
        });

        it('con finished:true puesto por el monolito, un intento nuevo recibe WINDOW_ENDED (no FORBIDDEN)', async () => {
            const { slug, user } = await scenario({ startMin: -60, endMin: -5, sim: { finished: true } });
            const res = await startOf(slug, user).expect(403);
            assert.equal(res.body.error.code, 'WINDOW_ENDED');
        });

        it('automatic no decide: con fechas se aplica la ventana aunque sea false o true', async () => {
            for (const automatic of [false, true]) {
                const { slug, user } = await scenario({ startMin: 10, endMin: 70, sim: { automatic } });
                assert.equal((await startOf(slug, user).expect(403)).body.error.code, 'NOT_STARTED');
            }
        });

        it('reabrir un intento iniciado cuyo tiempo vencio: ATTEMPT_ALREADY_FINISHED y queda calificado', async () => {
            const { slug, user, id } = await scenario({
                startMin: -60, endMin: -5,
                enrollment: { start_exam: new Date(Date.now() - 30 * minute), end_exam: new Date(Date.now() - 10 * minute), answers: {} },
            });
            const res = await startOf(slug, user).expect(409);
            assert.equal(res.body.error.code, 'ATTEMPT_ALREADY_FINISHED');
            assert.equal((await enrollments().findOne({ _id: id })).finished, true);
        });

        it('un intento ya cerrado: ATTEMPT_ALREADY_FINISHED', async () => {
            const { slug, user } = await scenario({ startMin: -1, endMin: 9, enrollment: { finished: true } });
            assert.equal((await startOf(slug, user).expect(409)).body.error.code, 'ATTEMPT_ALREADY_FINISHED');
        });

        it('un reintento abierto despues del fin entra, sin ventana ni tope', async () => {
            const { slug, user } = await scenario({
                startMin: -60, endMin: -5, sim: { finished: true }, enrollment: { attempt_number: 2 },
            });
            const { data } = (await startOf(slug, user).expect(200)).body;
            assert.equal(data.window, null);
            assert.equal(seconds(data), 180);
        });

        it('sin duracion configurada sigue siendo CONFLICT (no se confunde con "ya termino")', async () => {
            const { slug, user } = await scenario({ startMin: -1, endMin: 9, sim: { duration: null } });
            assert.equal((await startOf(slug, user).expect(409)).body.error.code, 'CONFLICT');
        });

        it('un no programado: window null', async () => {
            const user = await createUser(ctx);
            await call('post', '/simulacro-general/inscribirme', user, { fullname: 'Ana Pérez López', dni: '12345678' }).expect(201);
            assert.equal((await startOf('simulacro-general', user).expect(200)).body.data.window, null);
        });

        it('guardar: dentro de la holgura 200; pasada la holgura ATTEMPT_ALREADY_FINISHED', async () => {
            const open = await scenario({
                startMin: -60, endMin: 60,
                enrollment: { start_exam: new Date(Date.now() - 4 * minute), end_exam: new Date(Date.now() - 2 * 1000) },
            });
            await call('put', `/intentos/${open.id}/respuestas`, open.user, { answers: { a1: 'A' } }).expect(200);

            const over = await scenario({
                startMin: -60, endMin: 60,
                enrollment: { start_exam: new Date(Date.now() - 10 * minute), end_exam: new Date(Date.now() - 5 * minute) },
            });
            const res = await call('put', `/intentos/${over.id}/respuestas`, over.user, { answers: { a1: 'A' } }).expect(409);
            assert.equal(res.body.error.code, 'ATTEMPT_ALREADY_FINISHED');
        });

        it('guardar y finalizar un intento ya cerrado: ATTEMPT_ALREADY_FINISHED', async () => {
            const { user, id } = await scenario({
                startMin: -60, endMin: 60,
                enrollment: { start_exam: new Date(Date.now() - 4 * minute), end_exam: new Date(Date.now() + minute), finished: true },
            });
            const save = await call('put', `/intentos/${id}/respuestas`, user, { answers: { a1: 'A' } }).expect(409);
            assert.equal(save.body.error.code, 'ATTEMPT_ALREADY_FINISHED');
            const finish = await call('post', `/intentos/${id}/finalizar`, user, {}).expect(409);
            assert.equal(finish.body.error.code, 'ATTEMPT_ALREADY_FINISHED');
        });

        it('un attempt_number desfasado sigue siendo CONFLICT (no es "ya termino")', async () => {
            const { slug, user } = await scenario({ startMin: -1, endMin: 9 });
            const { attempt_id: attemptId } = (await startOf(slug, user).expect(200)).body.data;
            const res = await call('put', `/intentos/${attemptId}/respuestas`, user, { answers: { a1: 'A' }, attempt_number: 7 }).expect(409);
            assert.equal(res.body.error.code, 'CONFLICT');
        });

        it('finalizar dos veces: el segundo es ATTEMPT_ALREADY_FINISHED', async () => {
            const { slug, user } = await scenario({ startMin: -1, endMin: 9 });
            const { attempt_id: attemptId } = (await startOf(slug, user).expect(200)).body.data;
            await call('post', `/intentos/${attemptId}/finalizar`, user, {}).expect(200);
            const again = await call('post', `/intentos/${attemptId}/finalizar`, user, {}).expect(409);
            assert.equal(again.body.error.code, 'ATTEMPT_ALREADY_FINISHED');
        });

        describe('resultados y solucionario', () => {
            const results = (slug, user) => request(ctx.app).get(`${API}/${slug}/resultados`).set(user ? bearer(user) : {});
            const solucionario = (slug, user) => request(ctx.app).get(`${API}/${slug}/solucionario`).set(bearer(user));
            const publish = (slug) => sims().updateOne({ _id: `s-${slug}` }, { $set: { public_results: true } });
            /** Inscrito que rinde y finaliza dentro de la ventana en vivo (1 respuesta de varias). */
            const finishedParticipant = async (sim = {}) => {
                const ctxn = await scenario({ startMin: -1, endMin: 9, sim });
                const { attempt_id: attemptId } = (await startOf(ctxn.slug, ctxn.user).expect(200)).body.data;
                await call('put', `/intentos/${attemptId}/respuestas`, ctxn.user, { answers: { a1: 'A' } }).expect(200);
                await call('post', `/intentos/${attemptId}/finalizar`, ctxn.user, {}).expect(200);
                return ctxn;
            };

            it('sin publicar, un participante que termino solo ve que su examen quedo registrado', async () => {
                const { slug, user } = await finishedParticipant();
                const { body } = await results(slug, user).expect(200);
                const data = body.data;
                assert.equal(data.results_published, false);
                assert.equal(data.enrolled, true);
                assert.equal(data.absent, false);
                assert.equal(data.attempt, null);
                assert.deepEqual(data.by_area, []);
                assert.deepEqual(data.attempts, []);
                assert.deepEqual(data.ranking, { visible: false });
                assert.equal(data.can_retry, false);
                assert.ok(data.retry_blocked_reason);
                assert.ok(data.results_at);
                assert.equal(data.submission.answered, 1);
                assert.ok(data.submission.total > 1, `total=${data.submission.total}`);
                assert.match(data.submission.finished_at, /Z$/);
                assert.match(data.simulacrum.status, /live/);
                // Ni rastro del puntaje propio.
                assert.ok(!JSON.stringify(data).includes('"score"'));
            });

            it('sin publicar, quien aun no termino recibe submission null', async () => {
                const { slug, user } = await scenario({ startMin: -1, endMin: 9 });
                const { data } = (await results(slug, user).expect(200)).body;
                assert.equal(data.results_published, false);
                assert.equal(data.submission, null);
            });

            it('sin publicar, un no participante recibe 404', async () => {
                const { slug } = await scenario({ startMin: -1, endMin: 9 });
                await results(slug, await createUser(ctx)).expect(404);
                await results(slug).expect(401);
            });

            it('la calificacion perezosa corre aunque no se publique: el intento queda cerrado y calificado', async () => {
                const { slug, user, id } = await scenario({
                    startMin: -60, endMin: -5,
                    enrollment: { start_exam: new Date(Date.now() - 30 * minute), end_exam: new Date(Date.now() - 10 * minute), answers: {} },
                });
                const { data } = (await results(slug, user).expect(200)).body;
                assert.equal(data.attempt, null);
                assert.ok(data.submission, 'submission presente');
                const row = await enrollments().findOne({ _id: id });
                assert.equal(row.finished, true);
                assert.notEqual(row.score, undefined);
            });

            it('publicados: respuesta completa mas results_published y absent', async () => {
                const { slug, user } = await finishedParticipant();
                await publish(slug);
                const { data } = (await results(slug, user).expect(200)).body;
                assert.equal(data.results_published, true);
                assert.equal(data.absent, false);
                assert.ok(data.attempt && data.attempt.score !== undefined);
                assert.equal(data.ranking.visible, true);
                assert.equal(data.attempts.length, 1);
                assert.ok(data.results_at);
            });

            it('publicados, un no participante ve el ranking publico', async () => {
                const { slug } = await finishedParticipant();
                await publish(slug);
                const { data } = (await results(slug, await createUser(ctx)).expect(200)).body;
                assert.equal(data.enrolled, false);
                assert.equal(data.results_published, true);
            });

            it('un ausente (inscrito que nunca abrio el examen) ve absent:true antes y despues de publicar', async () => {
                const { slug, user } = await scenario({ startMin: -60, endMin: -5, enrollment: { ausent: true } });
                const before = (await results(slug, user).expect(200)).body.data;
                assert.equal(before.absent, true);
                assert.equal(before.submission, null);
                assert.equal(before.attempt, null);

                await publish(slug);
                const after = (await results(slug, user).expect(200)).body.data;
                assert.equal(after.absent, true);
                assert.equal(after.attempt, null);
                assert.equal(after.results_published, true);
            });

            it('no programados: /resultados sin cambios de forma (results_published true)', async () => {
                const user = await createUser(ctx);
                await call('post', '/simulacro-general/inscribirme', user, { fullname: 'Ana Pérez López', dni: '12345678' }).expect(201);
                const { data } = (await results('simulacro-general', user).expect(200)).body;
                assert.equal(data.results_published, true);
                assert.equal(data.absent, false);
            });

            it('solucionario de un programado: cerrado hasta publicar, aunque la ventana ya haya terminado', async () => {
                const { slug, user } = await scenario({
                    startMin: -60, endMin: -5,
                    enrollment: { start_exam: new Date(Date.now() - 30 * minute), end_exam: new Date(Date.now() - 20 * minute), finished: true },
                });
                const res = await solucionario(slug, user).expect(403);
                assert.match(res.body.error.message, /se publiquen los resultados/);

                await publish(slug);
                await solucionario(slug, user).expect(200);
            });

            it('solucionario: con la ventana en curso sigue cerrado aunque public_results sea true', async () => {
                const { slug, user } = await scenario({
                    startMin: -10, endMin: 50, sim: { public_results: true },
                    enrollment: { start_exam: new Date(Date.now() - 5 * minute), end_exam: new Date(Date.now() - 2 * minute), finished: true },
                });
                const res = await solucionario(slug, user).expect(403);
                assert.match(res.body.error.message, /cierre el simulacro/);
            });
        });
    });
});
