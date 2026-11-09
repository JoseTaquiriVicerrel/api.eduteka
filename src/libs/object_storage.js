// Almacenamiento de objetos con clave: disco local o Cloudflare R2 (API compatible con S3).
//
//   import { objectStorage } from '#Libs/object_storage.js';
//   await objectStorage.put('pdf/ab12....pdf', buffer, { contentType: 'application/pdf' });
//   const url = await objectStorage.signedUrl('pdf/ab12....pdf', { filename: 'lista.pdf' });
//
// El driver lo elige STORAGE_DRIVER (disk | r2). Quien llama no sabe cual hay detras, asi el paso
// de disco a R2 (fase 5) es un cambio de configuracion y no de codigo. Diferencia a tener en cuenta:
// en disco no hay URL firmada (`signedUrl` devuelve null) y quien llama transmite con `get`.
//
// Las claves se validan siempre (sin '..', sin '/' inicial, solo [A-Za-z0-9/_.-]): nunca se arman
// con lo que llega en una URL sin pasar por aqui.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { settings } from '#Config/settings.js';

export class InvalidObjectKeyError extends Error {
    constructor(key) {
        super(`Clave de objeto invalida: ${JSON.stringify(key)}`);
        this.name = 'InvalidObjectKeyError';
    }
}

const KEY_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

export const assertValidKey = (key) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 512) throw new InvalidObjectKeyError(key);
    if (!KEY_PATTERN.test(key)) throw new InvalidObjectKeyError(key);
    if (key.split('/').some((part) => part === '.' || part === '..')) throw new InvalidObjectKeyError(key);
    return key;
};

// Nombre de archivo para Content-Disposition: sin comillas ni saltos, y la version UTF-8 aparte.
const contentDisposition = (filename) => {
    if (!filename) return undefined;
    const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

// --- Disco ---------------------------------------------------------------------------

export const createDiskStorage = ({ rootDir }) => {
    const root = path.resolve(rootDir);
    const fileFor = (key) => {
        const file = path.resolve(root, assertValidKey(key));
        // Defensa adicional a la validacion: la ruta final tiene que quedar dentro de la raiz.
        if (!file.startsWith(root + path.sep)) throw new InvalidObjectKeyError(key);
        return file;
    };

    return Object.freeze({
        driver: 'disk',

        async put(key, body, { contentType } = {}) {
            const file = fileFor(key);
            await fsp.mkdir(path.dirname(file), { recursive: true });
            // Se escribe a un temporal y se renombra: un lector nunca ve un archivo a medias.
            const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
            try {
                if (body instanceof Readable) await pipeline(body, fs.createWriteStream(tmp));
                else await fsp.writeFile(tmp, body);
                await fsp.rename(tmp, file);
            } catch (error) {
                await fsp.rm(tmp, { force: true });
                throw error;
            }
            const { size } = await fsp.stat(file);
            return { key, bytes: size, contentType: contentType ?? null };
        },

        async get(key) {
            const file = fileFor(key);
            try {
                const { size } = await fsp.stat(file);
                return { body: fs.createReadStream(file), bytes: size };
            } catch (error) {
                if (error.code === 'ENOENT') return null;
                throw error;
            }
        },

        async exists(key) {
            try {
                await fsp.access(fileFor(key));
                return true;
            } catch (error) {
                if (error.code === 'ENOENT') return false;
                throw error;
            }
        },

        async delete(key) {
            await fsp.rm(fileFor(key), { force: true });
        },

        // En disco no hay URL firmada: quien llama transmite con `get`.
        async signedUrl() {
            return null;
        },
    });
};

// --- Cloudflare R2 (S3) ----------------------------------------------------------------

/**
 * `client` y `presign` se pueden inyectar (pruebas). Si no, se cargan de @aws-sdk al primer uso:
 * con STORAGE_DRIVER=disk el SDK ni se importa.
 */
export const createR2Storage = ({ accountId, accessKeyId, secretAccessKey, bucket, defaultTtlSeconds = 600, client, presign, sdk }) => {
    let ready = null;
    const load = () => {
        ready ??= (async () => {
            const s3 = sdk ?? await import('@aws-sdk/client-s3');
            const signer = presign ?? (await import('@aws-sdk/s3-request-presigner')).getSignedUrl;
            const s3Client = client ?? new s3.S3Client({
                region: 'auto', // lo exige el SDK; R2 no lo usa
                endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
                credentials: { accessKeyId, secretAccessKey },
            });
            return { s3, signer, s3Client };
        })();
        return ready;
    };

    const isNotFound = (error) => error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;

    return Object.freeze({
        driver: 'r2',

        async put(key, body, { contentType } = {}) {
            assertValidKey(key);
            const { s3, s3Client } = await load();
            const bytes = Buffer.isBuffer(body) ? body.length : undefined;
            await s3Client.send(new s3.PutObjectCommand({
                Bucket: bucket, Key: key, Body: body, ContentType: contentType, ContentLength: bytes,
            }));
            return { key, bytes: bytes ?? null, contentType: contentType ?? null };
        },

        async get(key) {
            assertValidKey(key);
            const { s3, s3Client } = await load();
            try {
                const result = await s3Client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
                return { body: result.Body, bytes: result.ContentLength ?? null };
            } catch (error) {
                if (isNotFound(error)) return null;
                throw error;
            }
        },

        async exists(key) {
            assertValidKey(key);
            const { s3, s3Client } = await load();
            try {
                await s3Client.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }));
                return true;
            } catch (error) {
                if (isNotFound(error)) return false;
                throw error;
            }
        },

        async delete(key) {
            assertValidKey(key);
            const { s3, s3Client } = await load();
            await s3Client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
        },

        async signedUrl(key, { ttlSeconds = defaultTtlSeconds, filename } = {}) {
            assertValidKey(key);
            const { s3, signer, s3Client } = await load();
            const command = new s3.GetObjectCommand({
                Bucket: bucket,
                Key: key,
                ResponseContentDisposition: contentDisposition(filename),
            });
            return signer(s3Client, command, { expiresIn: ttlSeconds });
        },
    });
};

// --- Instancia de la aplicacion -----------------------------------------------------------

export const createObjectStorage = (config = settings.objectStorage) => (config.driver === 'r2'
    ? createR2Storage({ ...config.r2, defaultTtlSeconds: config.signedUrlTtlSeconds })
    : createDiskStorage({ rootDir: config.diskDir }));

export const objectStorage = createObjectStorage();
