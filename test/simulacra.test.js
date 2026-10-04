import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp-compact';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedSimulacra } from './helpers/seed.js';

const API = '/api/v1/simulacros';
// "correct" no se prohibe en general: es tambien un conteo de aciertos (`correct: 3`) y el puntaje del
// simulacro. Lo que nunca debe salir es la clave de una pregunta (ver assertItemsHideAnswers).
const SECRET_KEYS = ['"rpta"', '"resolution"', '"explanation"', '"general_items"'];
const person = { fullname: 'Ana Pérez López', dni: '12345678' };

describe('simulacros', () => {
    let ctx;
    let captureDir;

    before(async () => {
        captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eduteka-captures-'));
        ctx = await bootTestApp({ PAY_CAPTURE_DIR: captureDir, ADMIN_EMAIL: 'admin@eduteka.test' });
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
    });
    after(async () => {
        await ctx.stop();
        fs.rmSync(captureDir, { recursive: true, force: true });
    });
    beforeEach(() => ctx.kv.flushMemory());

    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const api = (method, route, user, body) => request(ctx.app)[method](`${API}${route}`).set(user ? bearer(user) : {}).send(body);
    const get = (route, user) => request(ctx.app).get(`${API}${route}`).set(user ? bearer(user) : {});
    const enrollmentOf = (user, slug) => db('usersimulacrums').findOne({ user_id: user.session.user.id, simulacrum_id: `s-${slug}` });
    const assertNoSecrets = (body) => {
        const json = JSON.stringify(body);
        for (const key of SECRET_KEYS) assert.ok(!json.includes(key), `expone ${key}`);
    };
    // Una pregunta de un intento en curso no lleva clave ni explicacion.
    const assertItemsHideAnswers = (items) => {
        for (const item of items.filter((entry) => entry.kind === 'question')) {
            for (const key of ['correct', 'explanation', 'rpta', 'resolution', 'selected', 'is_correct']) {
                assert.ok(!(key in item), `la pregunta ${item.id} expone ${key}`);
            }
        }
    };

    /** Inscribe (gratis) y verifica; devuelve el usuario. */
    const enrolled = async (slug = 'simulacro-general', overrides = {}) => {
        const user = await createUser(ctx, overrides);
        await api('post', `/${slug}/inscribirme`, user, person).expect(201);
        return user;
    };
    const start = (slug, user) => api('post', `/${slug}/iniciar`, user);

    describe('GET /simulacros', () => {
        it('es publico, oculta lo no publicado y ordena del mas reciente al mas antiguo', async () => {
            const res = await get('').expect(200);
            const slugs = res.body.data.map((item) => item.slug);

            assert.deepEqual(slugs, [
                'simulacro-general', 'simulacro-areas', 'simulacro-pago', 'evento-proximo', 'evento-vivo', 'evento-cerrado',
                'cerrado-admin', 'privado', 'sin-inscripcion', 'simulacro-prospecto',
            ]);
            assert.ok(!slugs.includes('oculto') && !slugs.includes('borrador'));
            assert.equal(res.body.meta.total, 10);
            assertNoSecrets(res.body);
        });

        it('calcula el estado: bajo demanda = live; evento segun su ventana; cerrado por el administrador', async () => {
            const res = await get('?limit=50').expect(200);
            const status = Object.fromEntries(res.body.data.map((item) => [item.slug, item.status]));

            assert.equal(status['simulacro-general'], 'live');
            assert.equal(status['evento-proximo'], 'upcoming');
            assert.equal(status['evento-vivo'], 'live');
            assert.equal(status['evento-cerrado'], 'finished');
            assert.equal(status['cerrado-admin'], 'finished');
        });

        it('filtra por estado', async () => {
            const upcoming = await get('?status=upcoming').expect(200);
            assert.deepEqual(upcoming.body.data.map((item) => item.slug), ['evento-proximo']);

            const finished = await get('?status=finished').expect(200);
            assert.deepEqual(finished.body.data.map((item) => item.slug).sort(), ['cerrado-admin', 'evento-cerrado']);

            const live = await get('?status=live&limit=50').expect(200);
            assert.ok(live.body.data.every((item) => item.status === 'live'));
            assert.ok(live.body.data.some((item) => item.slug === 'evento-vivo'));
            assert.ok(!live.body.data.some((item) => ['evento-proximo', 'evento-cerrado', 'cerrado-admin'].includes(item.slug)));
        });

        it('filtra por institucion y titulo (literal), y valida', async () => {
            assert.equal((await get('?institution=inst-unmsm&limit=50').expect(200)).body.meta.total, 10);
            assert.equal((await get('?institution=otra').expect(200)).body.meta.total, 0);
            assert.deepEqual((await get('?q=prospecto').expect(200)).body.data.map((item) => item.slug), ['simulacro-prospecto']);
            assert.equal((await get('?q=(').expect(200)).body.meta.total, 0);
            await get('?status=otro').expect(422);
            await get('?limit=51').expect(422);
        });

        it('con sesion marca en cuales esta inscrito', async () => {
            const user = await enrolled('simulacro-general');
            const res = await get('?limit=50', user).expect(200);
            const byslug = Object.fromEntries(res.body.data.map((item) => [item.slug, item.enrolled]));

            assert.equal(byslug['simulacro-general'], true);
            assert.equal(byslug['simulacro-areas'], false);
            // Anonimo: el campo no aplica.
            assert.equal((await get('').expect(200)).body.data[0].enrolled, undefined);
        });
    });

    describe('GET /simulacros/:slug', () => {
        it('ficha publica: opciones de area, puntajes y conteos, sin preguntas ni claves', async () => {
            const res = await get('/simulacro-areas').expect(200);
            const { data } = res.body;

            assert.equal(data.ask_area, true);
            assert.equal(data.ask_career, true);
            assert.deepEqual(data.areas.map((area) => [area.key, area.questions_count]), [['A', 2], ['B', 1], ['C', 0]]);
            assert.deepEqual(data.areas[0].careers, ['Sistemas', 'Civil']);
            assert.deepEqual(data.scoring, { correct: 4, incorrect: -1, not_answered: 0 });
            assert.equal(data.status, 'live');
            assert.equal(data.enrollment, null);
            assert.ok(data.server_time);
            assertNoSecrets(res.body);
            assert.ok(!JSON.stringify(res.body).includes('"questions":'));
        });

        it('un simulacro con una sola area no pide area ni carrera', async () => {
            const { data } = (await get('/simulacro-general').expect(200)).body;
            assert.equal(data.ask_area, false);
            assert.equal(data.ask_career, false);
            assert.equal(data.image, 'https://eduteka.test/images/posts/sg.png');
        });

        it('no sirve simulacros ocultos (sin verificar o con state:false) ni inexistentes', async () => {
            for (const slug of ['oculto', 'borrador', 'no-existe']) await get(`/${slug}`).expect(404);
        });

        it('con sesion incluye la inscripcion y el estado del postulante', async () => {
            const user = await enrolled('simulacro-general');
            const before = (await get('/simulacro-general', user).expect(200)).body.data;
            assert.equal(before.enrolled, true);
            assert.equal(before.enrollment.state, 'registered');
            assert.equal(before.enrollment.verified, true);
            assert.equal(before.enrollment.can_retry, false);
            assert.equal(before.enrollment.retry_blocked_reason, 'Todavía tienes un intento en curso');

            await start('simulacro-general', user).expect(200);
            assert.equal((await get('/simulacro-general', user).expect(200)).body.data.enrollment.state, 'in_progress');
        });
    });

    describe('POST /simulacros/:slug/inscribirme', () => {
        it('exige sesion y una cuenta de estudiante (los docentes no rinden simulacros)', async () => {
            await api('post', '/simulacro-general/inscribirme', null, person).expect(401);
            const teacher = await createUser(ctx, { account_type: 'Profesor' });
            const res = await api('post', '/simulacro-general/inscribirme', teacher, person).expect(403);
            assert.equal(res.body.error.code, 'CAPABILITY_REQUIRED');
        });

        it('gratis: queda verificada al instante; fija el area unica; congela el precio', async () => {
            const user = await createUser(ctx);
            const res = await api('post', '/simulacro-general/inscribirme', user, person).expect(201);

            assert.equal(res.body.data.verified, true);
            assert.equal(res.body.data.area, 'I');
            assert.equal(res.body.data.career, null);
            assert.equal(res.body.data.amount_paid, 0);
            const stored = await enrollmentOf(user, 'simulacro-general');
            assert.equal(stored.dni, '12345678');
            assert.equal(stored.state, true);
            assert.equal((await ctx.User.findById(user.session.user.id)).fullname, 'Ana Pérez López');
        });

        it('valida los datos', async () => {
            const user = await createUser(ctx);
            await api('post', '/simulacro-general/inscribirme', user, {}).expect(422);
            await api('post', '/simulacro-general/inscribirme', user, { ...person, dni: '123' }).expect(422);
            await api('post', '/simulacro-general/inscribirme', user, { ...person, fullname: 'A' }).expect(422);
            await api('post', '/simulacro-general/inscribirme', user, { ...person, extra: 1 }).expect(422);
            assert.equal(await db('usersimulacrums').countDocuments({ user_id: user.session.user.id }), 0);
        });

        it('con varias areas exige un area valida y una carrera de esa area', async () => {
            const user = await createUser(ctx);
            const missing = await api('post', '/simulacro-areas/inscribirme', user, person).expect(422);
            assert.equal(missing.body.error.details[0].field, 'area');
            await api('post', '/simulacro-areas/inscribirme', user, { ...person, area: 'Z' }).expect(422);
            const career = await api('post', '/simulacro-areas/inscribirme', user, { ...person, area: 'A', career: 'Medicina' }).expect(422);
            assert.equal(career.body.error.details[0].field, 'career');

            const ok = await api('post', '/simulacro-areas/inscribirme', user, { ...person, area: 'A', career: 'Sistemas' }).expect(201);
            assert.deepEqual([ok.body.data.area, ok.body.data.career], ['A', 'Sistemas']);
        });

        it('no se inscribe dos veces (409) ni en simulacros ocultos (404) o con el registro cerrado (403)', async () => {
            const user = await enrolled('simulacro-general');
            const again = await api('post', '/simulacro-general/inscribirme', user, person).expect(409);
            assert.equal(again.body.error.code, 'CONFLICT');
            ctx.kv.flushMemory();
            const closed = await api('post', '/sin-inscripcion/inscribirme', user, person).expect(403);
            assert.equal(closed.body.error.code, 'FORBIDDEN');
            await api('post', '/oculto/inscribirme', user, person).expect(404);
        });

        it('dos inscripciones simultaneas no duplican la fila', async () => {
            const user = await createUser(ctx);
            const results = await Promise.all([
                api('post', '/simulacro-general/inscribirme', user, person),
                api('post', '/simulacro-general/inscribirme', user, person),
            ]);
            assert.deepEqual(results.map((res) => res.status).sort(), [201, 409]);
            assert.equal(await db('usersimulacrums').countDocuments({ user_id: user.session.user.id }), 1);
        });

        describe('de pago', () => {
            const png = async () => new Jimp(200, 300, 0x336699ff).getBufferAsync(Jimp.MIME_PNG);
            const pay = (user, buffer, fields = person, { filename = 'pago.png', contentType = 'image/png', field = 'screenshot' } = {}) => {
                let req = request(ctx.app).post(`${API}/simulacro-pago/inscribirme`).set(bearer(user));
                for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
                return buffer ? req.attach(field, buffer, { filename, contentType }) : req;
            };

            it('exige el comprobante', async () => {
                const user = await createUser(ctx);
                const res = await pay(user, null).expect(422);
                assert.equal(res.body.error.details[0].field, 'screenshot');
                assert.equal(await db('usersimulacrums').countDocuments({ user_id: user.session.user.id }), 0);
            });

            it('guarda el comprobante, queda pendiente de verificacion y avisa por correo', async () => {
                const user = await createUser(ctx);
                const before = ctx.outbox.length;
                const res = await pay(user, await png()).expect(201);

                assert.equal(res.body.data.verified, false);
                assert.equal(res.body.data.status_reason, 'Pendiente de verificación');
                assert.equal(res.body.data.amount_paid, 15);

                const stored = await enrollmentOf(user, 'simulacro-pago');
                assert.match(stored.screenshot, /^\/protected\/pay_capture\/[a-f0-9]{18}\.png$/);
                assert.ok(fs.existsSync(path.join(captureDir, path.basename(stored.screenshot))));

                const sent = ctx.outbox.slice(before);
                assert.deepEqual(sent.map((mail) => mail.template).sort(), ['api_simulacrum_enrolled', 'api_simulacrum_payment_review']);
                assert.ok(sent.some((mail) => mail.to === 'admin@eduteka.test'));
            });

            it('mientras no este verificada no puede iniciar el simulacro', async () => {
                const user = await createUser(ctx);
                await pay(user, await png()).expect(201);
                const res = await start('simulacro-pago', user).expect(403);
                assert.match(res.body.error.message, /verificada/);

                await db('usersimulacrums').updateOne({ user_id: user.session.user.id }, { $set: { state: true } });
                await start('simulacro-pago', user).expect(200);
            });

            it('rechaza un comprobante que no es una imagen real, otro tipo o demasiado grande', async () => {
                const user = await createUser(ctx);
                await pay(user, Buffer.from('no soy una imagen'), person, { filename: 'a.png' }).expect(422);
                await pay(user, await png(), person, { filename: 'a.gif', contentType: 'image/gif' }).expect(422);
                const big = await pay(user, Buffer.alloc(6 * 1024 * 1024, 1)).expect(413);
                assert.equal(big.body.error.code, 'PAYLOAD_TOO_LARGE');
                assert.equal(await db('usersimulacrums').countDocuments({ user_id: user.session.user.id }), 0);
                assert.deepEqual(fs.readdirSync(captureDir).filter((name) => !name.endsWith('.png')), []);
            });

            it('acepta el campo con el nombre que usa la web (capture)', async () => {
                const user = await createUser(ctx);
                await pay(user, await png(), person, { field: 'capture' }).expect(201);
            });
        });
    });

    describe('POST /simulacros/:slug/iniciar', () => {
        it('exige sesion y estar inscrito', async () => {
            await start('simulacro-general', null).expect(401);
            const stranger = await createUser(ctx);
            await start('simulacro-general', stranger).expect(404);
            await start('no-existe', stranger).expect(404);
        });

        it('fija el cronometro en el servidor y entrega las preguntas sin clave', async () => {
            const user = await enrolled();
            const before = Date.now();
            const res = await start('simulacro-general', user).expect(200);
            const { data } = res.body;

            assert.equal(data.attempt_number, 1);
            assert.equal(data.area, 'I');
            assert.equal(data.total_questions, 3);
            const startMs = new Date(data.start_exam).getTime();
            assert.ok(startMs >= before - 1000 && startMs <= Date.now() + 1000);
            assert.equal(new Date(data.end_exam).getTime() - startMs, 60 * 60_000);
            assert.ok(Math.abs(new Date(data.server_time).getTime() - Date.now()) < 5000);

            assert.deepEqual(data.items.map((item) => [item.kind, item.id, item.n]), [
                ['reading', 'r1', undefined], ['question', 'a1', 1], ['question', 'a2', 2], ['question', 'l1', 3],
            ]);
            assert.deepEqual(data.items[1].options.map((option) => option.key), ['A', 'B', 'C', 'D']);
            assert.match(data.items[1].question, /src="https:\/\/eduteka\.test\/images\/questions\/a1\.png"/);
            assert.match(data.items[0].text, /src="https:\/\/eduteka\.test\/images\/blocks\/r1\.png"/);
            assert.deepEqual(data.answers, {});
            assertNoSecrets(res.body);
            assertItemsHideAnswers(data.items);

            const stored = await enrollmentOf(user, 'simulacro-general');
            assert.equal(stored.start_exam.toISOString(), data.start_exam);
        });

        it('es idempotente: volver a iniciar devuelve el mismo cronometro y las respuestas guardadas', async () => {
            const user = await enrolled();
            const first = (await start('simulacro-general', user).expect(200)).body.data;
            await api('put', `/intentos/${first.attempt_id}/respuestas`, user, { answers: { a1: 'A' } }).expect(200);

            const second = (await start('simulacro-general', user).expect(200)).body.data;
            assert.equal(second.attempt_id, first.attempt_id);
            assert.equal(second.start_exam, first.start_exam);
            assert.equal(second.end_exam, first.end_exam);
            assert.deepEqual(second.answers, { a1: 'A' });
        });

        it('dos aperturas simultaneas comparten el mismo cronometro', async () => {
            const user = await enrolled();
            const [one, two] = await Promise.all([start('simulacro-general', user), start('simulacro-general', user)]);
            assert.equal(one.body.data.start_exam, two.body.data.start_exam);
            assert.equal(one.body.data.end_exam, two.body.data.end_exam);
        });

        it('por areas sirve solo las preguntas del area elegida', async () => {
            const user = await createUser(ctx);
            await api('post', '/simulacro-areas/inscribirme', user, { ...person, area: 'B', career: 'Medicina' }).expect(201);
            const { data } = (await start('simulacro-areas', user).expect(200)).body;
            assert.deepEqual(data.items.map((item) => item.id), ['b3']);
        });

        it('un area sin preguntas -> 409', async () => {
            const user = await createUser(ctx);
            await api('post', '/simulacro-areas/inscribirme', user, { ...person, area: 'C' }).expect(201);
            const res = await start('simulacro-areas', user).expect(409);
            assert.match(res.body.error.message, /no tiene preguntas/);
        });

        it('eventos: antes de la hora de inicio 403; en ventana si; cerrado 403', async () => {
            const early = await enrolled('evento-proximo');
            const blocked = await start('evento-proximo', early).expect(403);
            assert.match(blocked.body.error.message, /todavía no ha comenzado/);

            const live = await enrolled('evento-vivo');
            await start('evento-vivo', live).expect(200);

            const late = await enrolled('evento-cerrado');
            assert.match((await start('evento-cerrado', late).expect(403)).body.error.message, /ya cerró/);
        });

        it('un simulacro cerrado por el administrador no admite intentos oficiales (403)', async () => {
            const user = await enrolled('cerrado-admin');
            await start('cerrado-admin', user).expect(403);
        });

        it('un intento ya terminado -> 409', async () => {
            const user = await enrolled();
            const { attempt_id: attemptId } = (await start('simulacro-general', user).expect(200)).body.data;
            await api('post', `/intentos/${attemptId}/finalizar`, user, {}).expect(200);
            const res = await start('simulacro-general', user).expect(409);
            assert.equal(res.body.error.code, 'CONFLICT');
        });

        it('si se acabo el tiempo y nadie lo cerro, se califica con lo guardado y se avisa (409)', async () => {
            const user = await enrolled();
            const { attempt_id: attemptId } = (await start('simulacro-general', user).expect(200)).body.data;
            await api('put', `/intentos/${attemptId}/respuestas`, user, { answers: { a1: 'A' } }).expect(200);
            await db('usersimulacrums').updateOne({ _id: attemptId }, { $set: { end_exam: new Date(Date.now() - 1000) } });

            const res = await start('simulacro-general', user).expect(409);
            assert.match(res.body.error.message, /terminó/);
            const stored = await enrollmentOf(user, 'simulacro-general');
            assert.equal(stored.finished, true);
            assert.equal(stored.questions_correct, 1);
            assert.equal(stored.questions_not_answered, 2);
        });

        it('los docentes no pueden iniciar', async () => {
            const teacher = await createUser(ctx, { account_type: 'Profesor' });
            await start('simulacro-general', teacher).expect(403);
        });
    });

    describe('PUT /simulacros/intentos/:attempt_id/respuestas', () => {
        const save = (attemptId, user, answers, extra = {}) => api('put', `/intentos/${attemptId}/respuestas`, user, { answers, ...extra });
        let user;
        let attemptId;

        beforeEach(async () => {
            user = await enrolled();
            attemptId = (await start('simulacro-general', user).expect(200)).body.data.attempt_id;
        });

        it('exige sesion, ser el dueño del intento (404 si no) y una cuenta de estudiante', async () => {
            await save(attemptId, null, { a1: 'A' }).expect(401);
            const other = await enrolled();
            await save(attemptId, other, { a1: 'A' }).expect(404);
            await save('no-existe', user, { a1: 'A' }).expect(404);
        });

        it('guarda solo las claves enviadas (no reemplaza el mapa) y permite quitar con null', async () => {
            const first = await save(attemptId, user, { a1: 'a', a2: 'B' }).expect(200);
            assert.equal(first.body.data.saved, 2);
            assert.ok(first.body.data.server_time);

            await save(attemptId, user, { l1: 'C' }).expect(200);
            let stored = await db('usersimulacrums').findOne({ _id: attemptId });
            assert.deepEqual(Object.keys(stored.answers).sort(), ['a1', 'a2', 'l1']);
            assert.equal(stored.answers.a1.option, 'A'); // en mayusculas

            await save(attemptId, user, { a2: null }).expect(200);
            stored = await db('usersimulacrums').findOne({ _id: attemptId });
            assert.deepEqual(Object.keys(stored.answers).sort(), ['a1', 'l1']);
        });

        it('es idempotente', async () => {
            await save(attemptId, user, { a1: 'A' }).expect(200);
            await save(attemptId, user, { a1: 'A' }).expect(200);
            assert.deepEqual(Object.keys((await db('usersimulacrums').findOne({ _id: attemptId })).answers), ['a1']);
        });

        it('rechaza preguntas que no son de este intento y rutas peligrosas', async () => {
            const res = await save(attemptId, user, { b1: 'A' }).expect(422);
            assert.equal(res.body.error.details[0].field, 'answers.b1');
            await save(attemptId, user, { 'a1.x': 'A' }).expect(422);
            await save(attemptId, user, { r1: 'A' }).expect(422); // una lectura no se responde
            await save(attemptId, user, { a1: 'ZZZZ' }).expect(422);
            await save(attemptId, user, { a1: 5 }).expect(422);
            await save(attemptId, user, {}).expect(200);
            await api('put', `/intentos/${attemptId}/respuestas`, user, {}).expect(422);
            assert.equal(Object.keys((await db('usersimulacrums').findOne({ _id: attemptId })).answers ?? {}).length, 0);
        });

        it('un attempt_number que no es el vigente se rechaza (una app vieja no pisa el intento nuevo)', async () => {
            await save(attemptId, user, { a1: 'A' }, { attempt_number: 2 }).expect(409);
            await save(attemptId, user, { a1: 'A' }, { attempt_number: 1 }).expect(200);
        });

        it('hasta unos segundos despues de end_exam se acepta; pasada la holgura, 409', async () => {
            await db('usersimulacrums').updateOne({ _id: attemptId }, { $set: { end_exam: new Date(Date.now() - 2000) } });
            await save(attemptId, user, { a1: 'A' }).expect(200);

            await db('usersimulacrums').updateOne({ _id: attemptId }, { $set: { end_exam: new Date(Date.now() - 30_000) } });
            const late = await save(attemptId, user, { a2: 'B' }).expect(409);
            assert.match(late.body.error.message, /tiempo/);
            assert.deepEqual(Object.keys((await db('usersimulacrums').findOne({ _id: attemptId })).answers), ['a1']);
        });

        it('un intento terminado ya no acepta respuestas (409)', async () => {
            await api('post', `/intentos/${attemptId}/finalizar`, user, {}).expect(200);
            await save(attemptId, user, { a1: 'A' }).expect(409);
        });

        it('antes de iniciar el cronometro no se guarda nada (409)', async () => {
            const fresh = await enrolled();
            const row = await enrollmentOf(fresh, 'simulacro-general');
            await save(row._id, fresh, { a1: 'A' }).expect(409);
        });
    });

    describe('POST /simulacros/intentos/:attempt_id/finalizar', () => {
        const finish = (attemptId, user, body = {}) => api('post', `/intentos/${attemptId}/finalizar`, user, body);

        it('corrige con la formula del simulacro, congela el primer puntaje y archiva el intento', async () => {
            const user = await enrolled();
            const { attempt_id: attemptId } = (await start('simulacro-general', user).expect(200)).body.data;
            await api('put', `/intentos/${attemptId}/respuestas`, user, { answers: { a1: 'A', a2: 'C' } }).expect(200);

            const res = await finish(attemptId, user).expect(200);
            const { data } = res.body;

            // a1 correcta (A), a2 incorrecta (la clave es B), l1 sin responder: 4 - 1 + 0.
            assert.deepEqual([data.correct, data.incorrect, data.not_answered, data.total], [1, 1, 1, 3]);
            assert.equal(data.score, 3);
            assert.equal(data.attempt_number, 1);
            assert.ok(data.finished_at);
            assertNoSecrets(res.body);

            const stored = await db('usersimulacrums').findOne({ _id: attemptId });
            assert.equal(stored.finished, true);
            assert.equal(stored.official_score, 3);
            assert.deepEqual(stored.results.Matemática, {
                questions_count: 2, questions_correct: 1, questions_incorrect: 1, questions_not_answered: 0, score: 3,
            });
            assert.deepEqual(stored.results.Lenguaje, {
                questions_count: 1, questions_correct: 0, questions_incorrect: 0, questions_not_answered: 1, score: 0,
            });
            assert.ok(stored.time >= 0 && stored.time <= 5);

            const archived = await db('simulacrumattempts').find({ user_simulacrum_id: attemptId }).toArray();
            assert.equal(archived.length, 1);
            assert.equal(archived[0].attempt_number, 1);
            assert.equal(archived[0].score, 3);
        });

        it('acepta las ultimas respuestas en el propio cierre', async () => {
            const user = await enrolled();
            const { attempt_id: attemptId } = (await start('simulacro-general', user).expect(200)).body.data;
            const res = await finish(attemptId, user, { answers: { a1: 'A', a2: 'B', l1: 'C' } }).expect(200);
            assert.deepEqual([res.body.data.correct, res.body.data.score], [3, 12]);
        });

        it('finalizar dos veces -> 409; dos cierres simultaneos califican una sola vez', async () => {
            const user = await enrolled();
            const { attempt_id: attemptId } = (await start('simulacro-general', user).expect(200)).body.data;

            const results = await Promise.all([finish(attemptId, user), finish(attemptId, user)]);
            assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
            assert.equal(await db('simulacrumattempts').countDocuments({ user_simulacrum_id: attemptId }), 1);
            await finish(attemptId, user).expect(409);
        });

        it('pasado el tiempo se corrige con lo guardado y el tiempo no supera el limite', async () => {
            const user = await enrolled();
            const { attempt_id: attemptId } = (await start('simulacro-general', user).expect(200)).body.data;
            await api('put', `/intentos/${attemptId}/respuestas`, user, { answers: { a1: 'A', a2: 'B' } }).expect(200);
            await db('usersimulacrums').updateOne({ _id: attemptId }, { $set: {
                start_exam: new Date(Date.now() - 2 * 3_600_000), end_exam: new Date(Date.now() - 3_600_000),
            } });

            // Las respuestas de ultima hora llegan tarde y NO cuentan.
            const res = await finish(attemptId, user, { answers: { l1: 'C' } }).expect(200);
            assert.deepEqual([res.body.data.correct, res.body.data.not_answered], [2, 1]);
            const stored = await db('usersimulacrums').findOne({ _id: attemptId });
            assert.equal(stored.time, 3600);
            assert.equal(stored.exam_finished.toISOString(), stored.end_exam.toISOString());
        });

        it('no se puede cerrar un intento ajeno (404) ni uno sin iniciar (409)', async () => {
            const user = await enrolled();
            const other = await enrolled();
            const row = await enrollmentOf(user, 'simulacro-general');
            await finish(row._id, other).expect(404);
            await finish(row._id, user).expect(409);
        });

        it('valida el cuerpo y el attempt_number', async () => {
            const user = await enrolled();
            const { attempt_id: attemptId } = (await start('simulacro-general', user).expect(200)).body.data;
            await finish(attemptId, user, { extra: 1 }).expect(422);
            await finish(attemptId, user, { attempt_number: 3 }).expect(409);
            await finish(attemptId, user, { attempt_number: 1 }).expect(200);
        });
    });
});
