import { del, getJson, setJson } from '#Libs/kv.js';

// Cache del dashboard de progreso (/progreso): 5 minutos por usuario. Se
// invalida al registrar respuestas o cerrar una practica desde la API, asi que
// "Hoy" se mueve en cuanto el usuario practica; lo que escriba el monolito (la
// web) se ve cuando vence el cache.

export const PROGRESS_TTL_SECONDS = 5 * 60;

const key = (userId) => `progress:${userId}`;

export const getCachedProgress = (userId) => getJson(key(userId));

export const cacheProgress = (userId, value) => setJson(key(userId), value, PROGRESS_TTL_SECONDS);

export const invalidateProgress = (userId) => del(key(userId));
