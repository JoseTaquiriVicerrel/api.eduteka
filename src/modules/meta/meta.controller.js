import mongoose from 'mongoose';
import redisClient from '#Config/redis.js';
import { settings } from '#Config/settings.js';
import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';

// GET /config. Lo lee la app al arrancar: version minima, kill-switch de la
// tienda y modo mantenimiento. Es publico y responde incluso en mantenimiento.
export const getConfig = (req, res) => ok(res, {
    min_version: settings.app.minVersion,
    latest_version: settings.app.latestVersion,
    payments_enabled: settings.app.paymentsEnabled,
    maintenance: settings.app.maintenance,
    web_url: settings.app.webUrl,
    support_whatsapp: settings.app.supportWhatsapp,
    payment_methods: settings.app.paymentMethods,
});

const checkMongo = async () => {
    try {
        if (mongoose.connection.readyState !== 1) return 'down';
        await mongoose.connection.db.admin().ping();
        return 'up';
    } catch {
        return 'down';
    }
};

// 'memory' = Redis no conecto y la API corre con el cliente en memoria (ver
// #Config/redis.js): valido en desarrollo, pero en produccion significa que los
// limites y enfriamientos no se comparten entre instancias.
const checkRedis = async () => {
    if (redisClient.isMemoryFallback) return 'memory';
    try {
        return (await redisClient.ping()) === 'PONG' ? 'up' : 'down';
    } catch {
        return 'down';
    }
};

// GET /health. 503 si cae Mongo o Redis; Redis en memoria es 'degraded' (200) salvo
// en produccion, donde tambien responde 503.
export const getHealth = asyncHandler(async (req, res) => {
    const [mongo, redis] = await Promise.all([checkMongo(), checkRedis()]);

    let status = 'ok';
    if (redis === 'memory') status = 'degraded';
    if (mongo === 'down' || redis === 'down') status = 'down';

    const unavailable = status === 'down' || (status === 'degraded' && settings.isProduction);

    res.status(unavailable ? 503 : 200).json({
        data: { status, checks: { mongo, redis }, uptime_seconds: Math.round(process.uptime()) },
    });
});
