import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { bootTestApp } from './helpers/boot.js';
import { createUser, seedCatalog, seedSimulacra } from './helpers/seed.js';

const minute = 60_000;
const TIMEOUT = 3000;

describe('simulacros en vivo: socket', () => {
    let ctx;
    let server;
    let io;
    let url;
    let bus;
    let realtime;
    const open = new Set();

    const sims = () => ctx.mongoose.connection.db.collection('simulacrums');
    const enrollments = () => ctx.mongoose.connection.db.collection('usersimulacrums');

    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
        bus = await import('../src/modules/simulacra/realtime/simulacrum.events.js');
        realtime = await import('../src/modules/simulacra/realtime/simulacrum.realtime.js');

        const now = Date.now();
        await sims().insertOne({
            _id: 's-en-vivo', slug: 'en-vivo', title: 'En vivo', verified: true, state: true, automatic: false, finished: false,
            general: true, duration: 3, price: 0, for_register: true,
            register_close_date: new Date(now + 5 * minute), start_date: new Date(now + 10 * minute), end_date: new Date(now + 70 * minute),
            created_at: new Date(now),
        });

        server = http.createServer(ctx.app);
        io = realtime.attachRealtime(server);
        await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
        url = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        for (const socket of open) socket.close();
        await new Promise((resolve) => { io.close(resolve); });
        await ctx.stop();
    });

    const wait = (socket, event) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), TIMEOUT);
        socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
    });
    /** Verifica que NO llega nada durante un rato. */
    const silent = (socket, event, ms = 300) => new Promise((resolve, reject) => {
        const handler = () => reject(new Error(`llego ${event} sin esperarlo`));
        socket.once(event, handler);
        setTimeout(() => { socket.off(event, handler); resolve(); }, ms);
    });

    const client = (token) => {
        const socket = connect(url, {
            path: '/api/v1/realtime', transports: ['websocket'], auth: token === undefined ? {} : { token }, reconnection: false,
        });
        open.add(socket);
        return socket;
    };
    const connected = async (token) => {
        const socket = client(token);
        await wait(socket, 'connect');
        return socket;
    };
    const join = (socket, slug) => socket.timeout(TIMEOUT).emitWithAck('join', { slug });

    /** Usuario con inscripcion aprobada en `en-vivo`. */
    const enrolledUser = async (slug = 'en-vivo') => {
        const user = await createUser(ctx);
        await enrollments().insertOne({
            _id: `u-${user.session.user.id}-${slug}`, user_id: user.session.user.id, simulacrum_id: `s-${slug}`,
            state: true, finished: false, attempt_number: 1,
        });
        return user;
    };
    const token = (user) => user.session.access_token;

    it('conexion sin token o con token invalido: connect_error UNAUTHENTICATED', async () => {
        for (const bad of [undefined, '', 'no.es.un.token']) {
            const socket = client(bad);
            const error = await wait(socket, 'connect_error');
            assert.equal(error.message, 'UNAUTHENTICATED', String(bad));
        }
    });

    it('join de un inscrito: ack ok y sim:state con la fase correcta', async () => {
        const user = await enrolledUser();
        const socket = await connected(token(user));
        const state = wait(socket, 'sim:state');
        const ack = await join(socket, 'en-vivo');

        assert.equal(ack.ok, true);
        assert.equal(ack.state.phase, 'registration');
        assert.equal(ack.state.slug, 'en-vivo');
        assert.equal(ack.state.simulacrum_id, 's-en-vivo');
        assert.equal(ack.state.results_published, false);
        for (const key of ['server_time', 'register_close_date', 'start_date', 'end_date', 'results_at']) {
            assert.match(ack.state[key], /^\d{4}-\d{2}-\d{2}T.*Z$/, key);
        }
        assert.deepEqual(await state, ack.state);
    });

    it('join de un no inscrito o de un slug inexistente: el mismo NOT_FOUND', async () => {
        const stranger = await createUser(ctx);
        const socket = await connected(token(stranger));
        const notEnrolled = await join(socket, 'en-vivo');
        const missing = await join(socket, 'no-existe');
        assert.deepEqual(notEnrolled, { ok: false, code: 'NOT_FOUND' });
        assert.deepEqual(missing, notEnrolled);
    });

    it('join con un payload invalido: BAD_REQUEST', async () => {
        const socket = await connected(token(await enrolledUser()));
        assert.equal((await socket.timeout(TIMEOUT).emitWithAck('join', { slug: '' })).code, 'BAD_REQUEST');
        assert.equal((await socket.timeout(TIMEOUT).emitWithAck('join', { slug: 'en-vivo', extra: 1 })).code, 'BAD_REQUEST');
        assert.equal((await socket.timeout(TIMEOUT).emitWithAck('join', 'texto')).code, 'BAD_REQUEST');
    });

    it('una senal start llega a la sala y no a quien esta fuera de ella', async () => {
        const inside = await connected(token(await enrolledUser()));
        const outside = await connected(token(await enrolledUser()));
        await join(inside, 'en-vivo');

        const received = wait(inside, 'sim:start');
        const none = silent(outside, 'sim:start');
        assert.equal(bus.publishLocal({ v: 1, type: 'start', simulacrum_id: 's-en-vivo', slug: 'en-vivo' }), true);

        const state = await received;
        assert.equal(state.slug, 'en-vivo');
        await none;
    });

    it('cada tipo de senal se emite con su evento', async () => {
        const socket = await connected(token(await enrolledUser()));
        await join(socket, 'en-vivo');
        for (const type of ['close', 'start', 'end', 'results', 'updated']) {
            const received = wait(socket, `sim:${type}`);
            bus.publishLocal({ v: 1, type, simulacrum_id: 's-en-vivo', slug: 'en-vivo' });
            assert.equal((await received).simulacrum_id, 's-en-vivo', type);
        }
    });

    it('el estado se lee de Mongo en ese momento (la senal no lleva datos)', async () => {
        const socket = await connected(token(await enrolledUser()));
        await join(socket, 'en-vivo');

        const before = wait(socket, 'sim:updated');
        bus.publishLocal({ v: 1, type: 'updated', simulacrum_id: 's-en-vivo', slug: 'en-vivo' });
        assert.equal((await before).phase, 'registration');

        const now = Date.now();
        await sims().updateOne({ _id: 's-en-vivo' }, {
            $set: { start_date: new Date(now - 60 * minute), end_date: new Date(now - minute), finished: true, public_results: true },
        });
        try {
            const received = wait(socket, 'sim:end');
            // Un `slug` falso en la senal no importa: manda el simulacro de la base.
            bus.publishLocal({ v: 1, type: 'end', simulacrum_id: 's-en-vivo', slug: 'otro' });
            const state = await received;
            assert.equal(state.phase, 'finished');
            assert.equal(state.results_published, true);
            assert.equal(state.slug, 'en-vivo');
        } finally {
            const reset = Date.now();
            await sims().updateOne({ _id: 's-en-vivo' }, {
                $set: { start_date: new Date(reset + 10 * minute), end_date: new Date(reset + 70 * minute), finished: false },
                $unset: { public_results: '' },
            });
        }
    });

    it('un mensaje malformado del bus se ignora y no tumba nada', async () => {
        const socket = await connected(token(await enrolledUser()));
        await join(socket, 'en-vivo');

        const none = silent(socket, 'sim:start');
        for (const bad of [null, 'texto', {}, { v: 2, type: 'start', simulacrum_id: 's-en-vivo' }, { v: 1, type: 'otro', simulacrum_id: 's-en-vivo' }, { v: 1, type: 'start' }]) {
            assert.equal(bus.publishLocal(bad), false);
        }
        assert.equal(bus.parseSignal('{no es json'), null);
        assert.equal(bus.parseSignal(JSON.stringify({ v: 1, type: 'start', simulacrum_id: 's-en-vivo', slug: 'en-vivo' })).type, 'start');
        await none;

        // Y el bus sigue vivo.
        const received = wait(socket, 'sim:start');
        bus.publishLocal({ v: 1, type: 'start', simulacrum_id: 's-en-vivo', slug: 'en-vivo' });
        await received;
    });

    it('una senal de un simulacro inexistente no hace nada', async () => {
        const socket = await connected(token(await enrolledUser()));
        await join(socket, 'en-vivo');
        const none = silent(socket, 'sim:start');
        bus.publishLocal({ v: 1, type: 'start', simulacrum_id: 's-fantasma', slug: 'fantasma' });
        await none;
    });

    it('la sexta conexion del mismo usuario cierra la primera', async () => {
        const user = await createUser(ctx);
        const sockets = [];
        for (let i = 0; i < 5; i += 1) sockets.push(await connected(token(user)));
        assert.ok(sockets.every((socket) => socket.connected));

        const firstClosed = wait(sockets[0], 'disconnect');
        sockets.push(await connected(token(user)));
        await firstClosed;
        assert.equal(sockets[0].connected, false);
        assert.ok(sockets.slice(1).every((socket) => socket.connected));
    });

    it('un usuario desactivado no se conecta', async () => {
        const user = await createUser(ctx);
        await ctx.mongoose.connection.db.collection('users').updateOne({ email: user.email }, { $set: { state: false } });
        const error = await wait(client(token(user)), 'connect_error');
        assert.equal(error.message, 'UNAUTHENTICATED');
    });

    it('limite de join: pasadas 20 por minuto, TOO_MANY_REQUESTS', async () => {
        const socket = await connected(token(await enrolledUser()));
        let last;
        for (let i = 0; i < 21; i += 1) last = await join(socket, 'en-vivo');
        assert.deepEqual(last, { ok: false, code: 'TOO_MANY_REQUESTS' });
    });
});
