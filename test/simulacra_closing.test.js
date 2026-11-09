import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { bearer, createUser, seedCatalog, seedSimulacra } from './helpers/seed.js';

// Cierre de la ventana (scheduler/simulacrum.closing.js): lo que hace el planificador a end_date,
// sin colas. Se califica con el MISMO cierre que `finalizar` (gradeAndClose).

const API = '/api/v1/simulacros';
const minute = 60_000;

describe('cierre de la ventana de un simulacro programado', () => {
    let ctx;
    let closing;
    const sims = () => ctx.mongoose.connection.db.collection('simulacrums');
    const enrollments = () => ctx.mongoose.connection.db.collection('usersimulacrums');
    const archive = () => ctx.mongoose.connection.db.collection('simulacrumattempts');
    const call = (method, route, user, body) => request(ctx.app)[method](`${API}${route}`).set(bearer(user)).send(body);

    let counter = 0;
    // Programado en vivo con las preguntas de `simulacro-general` (a1 = 'A' es correcta; scoring 4/-1/0).
    const live = async (sim = {}) => {
        counter += 1;
        const slug = `cierre-${counter}`;
        const base = await sims().findOne({ _id: 's-simulacro-general' });
        const now = Date.now();
        await sims().insertOne({
            ...base, _id: `s-${slug}`, slug, automatic: false, finished: false, duration: 3, public_results: undefined,
            register_close_date: new Date(now - 2 * minute), start_date: new Date(now - minute), end_date: new Date(now + 5 * minute),
            ...sim,
        });
        return `s-${slug}`;
    };
    const enrolled = async (simId, suffix, extra = {}) => {
        const user = await createUser(ctx);
        const id = `u-${simId}-${suffix}`;
        await enrollments().insertOne({
            _id: id, user_id: user.session.user.id, simulacrum_id: simId, fullname: 'Ana Pérez', area: 'I',
            state: true, finished: false, attempt_number: 1, ...extra,
        });
        return { user, id };
    };
    // La ventana termina "ahora": se mueve end_date al pasado, como si hubiera vencido.
    const endWindow = (simId) => sims().updateOne({ _id: simId }, { $set: { end_date: new Date(Date.now() - 1000) } });

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
        closing = await import('../src/modules/simulacra/scheduler/simulacrum.closing.js');
    });
    after(() => ctx.stop());

    it('marca ausentes solo a quien nunca abrio el examen en su primer intento', async () => {
        const simId = await live();
        const absent = await enrolled(simId, 'ausente');
        const started = await enrolled(simId, 'rindio', { start_exam: new Date(), end_exam: new Date(Date.now() + minute) });
        const retry = await enrolled(simId, 'reintento', { attempt_number: 2 });
        const pending = await enrolled(simId, 'pago-pendiente', { state: false });

        assert.equal(await closing.markAbsent(simId), 1);
        assert.equal(await closing.markAbsent(simId), 0, 'idempotente');

        const byId = Object.fromEntries((await enrollments().find({ simulacrum_id: simId }).toArray()).map((row) => [row._id, row]));
        assert.equal(byId[absent.id].ausent, true);
        assert.equal(byId[started.id].ausent, undefined);
        assert.equal(byId[retry.id].ausent, undefined, 'un reintento sin empezar no es un ausente');
        assert.equal(byId[pending.id].ausent, undefined, 'una inscripcion sin aprobar no cuenta');
    });

    it('califica el intento abierto con el mismo cierre que finalizar, y solo una vez', async () => {
        const simId = await live();
        const { user, id } = await enrolled(simId, 'rinde');
        const slug = simId.slice(2);

        await call('post', `/${slug}/iniciar`, user).expect(200);
        await call('put', `/intentos/${id}/respuestas`, user, { answers: { a1: 'A' } }).expect(200);
        await endWindow(simId);

        assert.deepEqual(await closing.openAttemptIds(simId), [id]);
        assert.equal(await closing.gradeOpenAttempt({ simulacrumId: simId, userSimulacrumId: id }), 'graded');
        assert.equal(await closing.gradeOpenAttempt({ simulacrumId: simId, userSimulacrumId: id }), 'closed', 'repetir no califica dos veces');

        const row = await enrollments().findOne({ _id: id });
        assert.equal(row.finished, true);
        assert.equal(row.questions_correct, 1);
        assert.equal(row.score, 4, 'una correcta con score_correct 4');
        assert.equal(row.official_score, 4, 'primer intento: congela el puntaje del ranking');
        assert.ok(row.exam_finished <= row.end_exam, 'nunca cuenta tiempo pasado el limite del intento');
        assert.deepEqual(await closing.openAttemptIds(simId), []);
        assert.equal(await archive().countDocuments({ user_simulacrum_id: id }), 1, 'archivado una vez');
    });

    it('no toca un reintento en curso, un intento sin empezar ni uno de otro simulacro', async () => {
        const simId = await live();
        const other = await live();
        const retry = await enrolled(simId, 'reintento', { attempt_number: 2, start_exam: new Date(), end_exam: new Date(Date.now() + minute) });
        const unstarted = await enrolled(simId, 'sin-empezar');
        const foreign = await enrolled(other, 'ajeno', { start_exam: new Date(), end_exam: new Date() });

        assert.equal(await closing.gradeOpenAttempt({ simulacrumId: simId, userSimulacrumId: retry.id }), 'retry');
        assert.equal(await closing.gradeOpenAttempt({ simulacrumId: simId, userSimulacrumId: unstarted.id }), 'unstarted');
        assert.equal(await closing.gradeOpenAttempt({ simulacrumId: simId, userSimulacrumId: foreign.id }), 'missing');
        assert.equal(await closing.gradeOpenAttempt({ simulacrumId: simId, userSimulacrumId: 'no-existe' }), 'missing');
        assert.equal((await enrollments().findOne({ _id: retry.id })).finished, false);
    });

    it('finalizeWindow cierra el simulacro y publica los resultados al terminar la ventana', async () => {
        const simId = await live();
        const { id } = await enrolled(simId, 'ya-cerrado', { finished: true });
        await endWindow(simId);

        const { simulacrum, published } = await closing.finalizeWindow(simId);
        assert.equal(simulacrum.finished, true);
        assert.equal(published, true);
        assert.equal(simulacrum.public_results, true);
        assert.equal((await enrollments().findOne({ _id: id })).public_results, true);

        const again = await closing.finalizeWindow(simId);
        assert.equal(again.published, false, 'idempotente: no vuelve a publicar');
    });

    it('con resultados programados despues del fin, cierra pero no publica todavia', async () => {
        const simId = await live({ results_public_at: new Date(Date.now() + 60 * minute) });
        await endWindow(simId);

        const { simulacrum, published } = await closing.finalizeWindow(simId);
        assert.equal(simulacrum.finished, true);
        assert.equal(published, false);
        assert.notEqual(simulacrum.public_results, true);

        // A la hora de publicar, el hito `results` lo hace con publishResults.
        assert.equal(await closing.publishResults(simId), true);
        assert.equal(await closing.publishResults(simId), false);
    });
});
