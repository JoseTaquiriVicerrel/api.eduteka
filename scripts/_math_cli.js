import mongoose from 'mongoose';
import { settings } from '#Config/settings.js';
import { SOURCES } from '#Libs/math_catalog.js';

// Utilidades comunes de los scripts de formulas LaTeX.

/** Lee --clave=valor y --bandera. Rechaza las que no estan en `allowed` (un `--aply` no debe ignorarse en silencio). */
export const parseArgs = (argv, allowed) => {
    const args = {};
    for (const arg of argv) {
        const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
        if (!match) throw new Error(`Argumento no reconocido: ${arg}`);
        if (!allowed.includes(match[1])) throw new Error(`Opcion desconocida: ${arg} (validas: ${allowed.map((name) => `--${name}`).join(', ')})`);
        args[match[1]] = match[2] ?? true;
    }
    return args;
};

export const parseSources = (value) => {
    if (!value || value === true) return [...SOURCES];
    const sources = String(value).split(',').map((item) => item.trim());
    const unknown = sources.filter((item) => !SOURCES.includes(item));
    if (unknown.length) throw new Error(`Fuente desconocida: ${unknown.join(', ')} (validas: ${SOURCES.join(', ')})`);
    return sources;
};

/** Conecta a Mongo como la API (sin crear indices: son del monolito). */
export const connect = async () => {
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    await mongoose.connect(settings.mongoUri, { serverSelectionTimeoutMS: 10_000 });
    console.log(`MongoDB: ${mongoose.connection.host}/${mongoose.connection.name}`);
};

export const disconnect = () => mongoose.disconnect();

/** Escribe una linea de progreso que se sobrescribe (solo en terminal). */
export const progress = (text) => {
    if (process.stdout.isTTY) process.stdout.write(`\r${text}\u001b[K`);
};
export const endProgress = () => {
    if (process.stdout.isTTY) process.stdout.write('\r\u001b[K');
};
