// Socket de los simulacros programados (contrato §7.2). Solo retransmite: lee el estado de Mongo en el
// momento de cada senal y lo emite a la sala del simulacro. Nunca decide nada.
//
//   conexion   auth: { token } (access token: app, y web Next via BFF), o la cookie `session` del
//              monolito (paginas SSR, mismo origen), validada EN el monolito como el puente de sesion.
//   join       { slug } (app) o { simulacrum_id } (SSR) -> ack { ok, state } y un `sim:state`.
//              Solo quien tiene inscripcion.
//   eventos    sim:state | sim:close | sim:start | sim:end | sim:results | sim:updated

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Server } from 'socket.io';
import SimulacrumModel from '#Models/simulacrum_model.js';
import UserModel from '#Models/user_model.js';
import UserSimulacrumModel from '#Models/user_simulacrum_model.js';
import { settings } from '#Config/settings.js';
import { logger } from '#Libs/logger.js';
import { verifyAccessToken } from '#Libs/tokens.js';
import { monolithSessionUser } from '#Modules/auth/auth.service.js';
import { onResync, subscribe } from './simulacrum.events.js';
import { getPhase, resultsAt, resultsPublished } from '../simulacrum.window.js';

const JOIN_PER_MINUTE = 20;
const JoinPayload = Type.Union([
    Type.Object({ slug: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
    Type.Object({ simulacrum_id: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }) }, { additionalProperties: false }),
]);

// Cookie `session` del monolito: un JWT. Solo [A-Za-z0-9._-], igual que WebExchangeBody: se pega en
// una cabecera Cookie hacia el monolito y no puede cerrar la cookie ni abrir otra cabecera.
const SESSION_COOKIE = /(?:^|;\s*)session=([A-Za-z0-9._-]{20,4096})(?:;|$)/;
const sessionCookieOf = (header) => (typeof header === 'string' ? SESSION_COOKIE.exec(header)?.[1] ?? null : null);

/** id del usuario del handshake: Bearer primero; si no hay, la cookie del monolito. null = sin sesion. */
const handshakeUserId = async (handshake) => {
    const token = handshake.auth?.token;
    if (typeof token === 'string' && token) {
        const { uid } = await verifyAccessToken(token);
        return uid;
    }
    if (!settings.realtime.cookieAuth || !settings.webClient.monolithUrl) return null;
    const session = sessionCookieOf(handshake.headers?.cookie);
    if (!session) return null;
    return monolithSessionUser(session, { ip: handshake.headers?.['x-real-ip'] ?? handshake.address });
};

const room = (simulacrumId) => `simulacrum:${simulacrumId}`;
const iso = (value) => {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : new Date(time).toISOString();
};

// Solo lo que hace falta para calcular el estado: no se cargan las preguntas.
const STATE_FIELDS = {
    slug: 1, verified: 1, state: 1, finished: 1, for_register: 1, start_date: 1, end_date: 1,
    register_close_date: 1, results_public_at: 1, public_results: 1,
};

/** Cuerpo comun a todos los eventos (contrato §7.2). Un simulacro sin horario sale `live` y sin fechas. */
export const buildState = (simulacrum, now = new Date()) => ({
    slug: simulacrum.slug,
    simulacrum_id: simulacrum._id,
    phase: getPhase(simulacrum, now),
    server_time: now.toISOString(),
    register_close_date: iso(simulacrum.register_close_date ?? simulacrum.start_date),
    start_date: iso(simulacrum.start_date),
    end_date: iso(simulacrum.end_date),
    results_at: iso(resultsAt(simulacrum)),
    results_published: resultsPublished(simulacrum),
});

export function attachRealtime(httpServer) {
    const io = new Server(httpServer, {
        path: settings.realtime.path,
        serveClient: false, // el cliente lo trae la app
        // `credentials` para el cliente SSR en desarrollo (otro puerto del mismo sitio, con cookie).
        cors: { origin: (origin, callback) => callback(null, !origin || settings.corsOrigins.includes(origin)), credentials: true },
        transports: ['websocket', 'polling'],
        maxHttpBufferSize: 10_000, // solo viajan mensajes minusculos
    });

    // --- Autenticacion del handshake (mismo criterio que middlewares/authenticate.js) ---
    io.use(async (socket, next) => {
        try {
            const uid = await handshakeUserId(socket.handshake);
            if (!uid) return next(new Error('UNAUTHENTICATED'));
            const user = await UserModel.findById(uid, { _id: 1, state: 1 }).lean().exec();
            if (!user || user.state === false) return next(new Error('UNAUTHENTICATED'));
            socket.data.userId = user._id;
            return next();
        } catch {
            return next(new Error('UNAUTHENTICATED'));
        }
    });

    // --- Tope de conexiones por usuario: la que sobra es la mas antigua ---
    const byUser = new Map(); // userId -> [socket, ...] (la mas antigua primero)
    io.on('connection', (socket) => {
        const { userId } = socket.data;
        const sockets = byUser.get(userId) ?? [];
        sockets.push(socket);
        byUser.set(userId, sockets);
        while (sockets.length > settings.realtime.maxConnectionsPerUser) sockets.shift().disconnect(true);

        socket.on('disconnect', () => {
            const rest = (byUser.get(userId) ?? []).filter((item) => item !== socket);
            if (rest.length) byUser.set(userId, rest);
            else byUser.delete(userId);
        });

        // --- join ---
        let joinWindowStart = Date.now();
        let joinCount = 0;
        socket.on('join', async (payload, ack) => {
            const reply = typeof ack === 'function' ? ack : () => {};
            try {
                const now = Date.now();
                if (now - joinWindowStart > 60_000) { joinWindowStart = now; joinCount = 0; }
                joinCount += 1;
                if (joinCount > JOIN_PER_MINUTE) return reply({ ok: false, code: 'TOO_MANY_REQUESTS' });

                if (!Value.Check(JoinPayload, payload)) return reply({ ok: false, code: 'BAD_REQUEST' });

                const simulacrum = await SimulacrumModel
                    .findOne({
                        ...(payload.slug ? { slug: payload.slug } : { _id: payload.simulacrum_id }),
                        verified: true,
                        state: { $ne: false },
                    }, STATE_FIELDS).lean().exec();
                const enrolled = simulacrum
                    && await UserSimulacrumModel.exists({ user_id: userId, simulacrum_id: simulacrum._id });
                // Mismo codigo para "no existe" y "no estas inscrito": no revela cual de los dos.
                if (!simulacrum || !enrolled) return reply({ ok: false, code: 'NOT_FOUND' });

                await socket.join(room(simulacrum._id));
                const state = buildState(simulacrum);
                reply({ ok: true, state });
                socket.emit('sim:state', state);
                return undefined;
            } catch (error) {
                logger.error({ err: error?.message }, 'Error en join de simulacro');
                return reply({ ok: false, code: 'INTERNAL_ERROR' });
            }
        });
    });

    const activeRooms = () => [...io.sockets.adapter.rooms.keys()]
        .filter((name) => name.startsWith('simulacrum:') && (io.sockets.adapter.rooms.get(name)?.size ?? 0) > 0);

    // --- Retransmision: el estado se lee de Mongo en este momento, no se reenvia nada de la senal ---
    const unsubscribe = subscribe(async (signal) => {
        const name = room(signal.simulacrum_id);
        if (!io.sockets.adapter.rooms.get(name)?.size) return; // nadie escucha: no se toca la base
        const simulacrum = await SimulacrumModel.findById(signal.simulacrum_id, STATE_FIELDS).lean().exec();
        if (!simulacrum) return;
        io.to(name).emit(`sim:${signal.type}`, buildState(simulacrum));
    });

    // --- Tras reconectar a Redis: reenvia el estado de cada sala activa para cubrir lo perdido ---
    const unsubscribeResync = onResync(async () => {
        for (const name of activeRooms()) {
            const simulacrum = await SimulacrumModel.findById(name.slice('simulacrum:'.length), STATE_FIELDS).lean().exec();
            if (simulacrum) io.to(name).emit('sim:state', buildState(simulacrum));
        }
    });

    const close = io.close.bind(io);
    io.close = (callback) => { unsubscribe(); unsubscribeResync(); return close(callback); };

    return io;
}
