import './helpers/env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import {
    InvalidObjectKeyError, assertValidKey, createDiskStorage, createObjectStorage, createR2Storage,
} from '#Libs/object_storage.js';

describe('claves de objeto', () => {
    it('acepta claves con carpetas', () => {
        for (const key of ['pdf/ab12.pdf', 'materials/2026/x_y-z.docx', 'a']) assert.equal(assertValidKey(key), key);
    });

    it('rechaza recorridos, rutas absolutas y caracteres raros', () => {
        for (const key of ['', '/pdf/a.pdf', 'pdf/../.env', '..', 'pdf/./a', 'a//b', 'a\\b', 'a b', 'pdf/ñ.pdf', 'a?b', 'x'.repeat(513), null, 7]) {
            assert.throws(() => assertValidKey(key), InvalidObjectKeyError, String(key));
        }
    });
});

describe('driver de disco', () => {
    let root;
    let storage;

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'edk-objects-'));
        storage = createDiskStorage({ rootDir: root });
    });
    after(async () => { await fs.rm(root, { recursive: true, force: true }); });

    it('guarda un buffer, lo lee como stream y lo borra', async () => {
        const saved = await storage.put('pdf/a.pdf', Buffer.from('hola'), { contentType: 'application/pdf' });
        assert.deepEqual(saved, { key: 'pdf/a.pdf', bytes: 4, contentType: 'application/pdf' });
        assert.equal(await storage.exists('pdf/a.pdf'), true);

        const object = await storage.get('pdf/a.pdf');
        assert.equal(object.bytes, 4);
        assert.equal(await text(object.body), 'hola');

        await storage.delete('pdf/a.pdf');
        assert.equal(await storage.exists('pdf/a.pdf'), false);
        assert.equal(await storage.get('pdf/a.pdf'), null);
    });

    it('guarda desde un stream y no deja temporales', async () => {
        await storage.put('docs/b.txt', Readable.from(['uno ', 'dos']));
        assert.equal(await text((await storage.get('docs/b.txt')).body), 'uno dos');
        assert.deepEqual(await fs.readdir(path.join(root, 'docs')), ['b.txt']);
    });

    it('borrar lo que no existe no falla y no hay URL firmada en disco', async () => {
        await storage.delete('nada/x.pdf');
        assert.equal(await storage.signedUrl('pdf/a.pdf'), null);
    });

    it('nunca escribe fuera de la raiz', async () => {
        await assert.rejects(storage.put('../fuera.txt', Buffer.from('x')), InvalidObjectKeyError);
        await assert.rejects(storage.get('/etc/passwd'), InvalidObjectKeyError);
    });
});

describe('driver de R2 (cliente S3 simulado)', () => {
    // SDK falso: cada comando guarda su nombre y su entrada; `send` responde segun el comando.
    class Command { constructor(input) { this.input = input; } }
    const sdk = {
        PutObjectCommand: class PutObjectCommand extends Command {},
        GetObjectCommand: class GetObjectCommand extends Command {},
        HeadObjectCommand: class HeadObjectCommand extends Command {},
        DeleteObjectCommand: class DeleteObjectCommand extends Command {},
    };
    const objects = new Map();
    const sent = [];
    const client = {
        async send(command) {
            sent.push({ name: command.constructor.name, input: command.input });
            const { Key } = command.input;
            const notFound = () => Object.assign(new Error('not found'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
            switch (command.constructor.name) {
            case 'PutObjectCommand': objects.set(Key, command.input.Body); return {};
            case 'HeadObjectCommand': if (!objects.has(Key)) throw Object.assign(notFound(), { name: 'NotFound' }); return {};
            case 'GetObjectCommand': if (!objects.has(Key)) throw notFound(); return { Body: Readable.from([objects.get(Key)]), ContentLength: objects.get(Key).length };
            case 'DeleteObjectCommand': objects.delete(Key); return {};
            default: throw new Error('comando inesperado');
            }
        },
    };
    const presign = async (_client, command, { expiresIn }) => `https://r2.test/${command.input.Bucket}/${command.input.Key}?ttl=${expiresIn}&cd=${encodeURIComponent(command.input.ResponseContentDisposition ?? '')}`;
    const storage = createR2Storage({ bucket: 'edk-private', defaultTtlSeconds: 600, client, presign, sdk });

    it('sube con el bucket, la clave, el tipo y el tamano', async () => {
        const saved = await storage.put('pdf/c.pdf', Buffer.from('pdf!'), { contentType: 'application/pdf' });
        assert.deepEqual(saved, { key: 'pdf/c.pdf', bytes: 4, contentType: 'application/pdf' });
        const put = sent.find((entry) => entry.name === 'PutObjectCommand');
        assert.equal(put.input.Bucket, 'edk-private');
        assert.equal(put.input.ContentType, 'application/pdf');
        assert.equal(put.input.ContentLength, 4);
    });

    it('exists y get distinguen "no existe" de un error', async () => {
        assert.equal(await storage.exists('pdf/c.pdf'), true);
        assert.equal(await storage.exists('pdf/no.pdf'), false);
        assert.equal(await storage.get('pdf/no.pdf'), null);
        assert.equal(await text((await storage.get('pdf/c.pdf')).body), 'pdf!');
    });

    it('firma URLs con la vida por defecto o la pedida, y el nombre de descarga', async () => {
        assert.match(await storage.signedUrl('pdf/c.pdf'), /ttl=600/);
        const url = await storage.signedUrl('pdf/c.pdf', { ttlSeconds: 60, filename: 'Lista de práctica.pdf' });
        assert.match(url, /ttl=60&/);
        const disposition = decodeURIComponent(url.split('cd=')[1]);
        assert.match(disposition, /^attachment; filename="Lista de pr_ctica\.pdf"; filename\*=UTF-8''Lista%20de%20pr%C3%A1ctica\.pdf$/);
    });

    it('valida la clave antes de llamar a R2', async () => {
        const before = sent.length;
        await assert.rejects(storage.put('../x', Buffer.from('x')), InvalidObjectKeyError);
        await assert.rejects(storage.signedUrl('/x'), InvalidObjectKeyError);
        assert.equal(sent.length, before);
    });

    it('borra', async () => {
        await storage.delete('pdf/c.pdf');
        assert.equal(await storage.exists('pdf/c.pdf'), false);
    });
});

describe('instancia segun STORAGE_DRIVER', () => {
    it('disk por defecto y r2 cuando se pide', () => {
        assert.equal(createObjectStorage({ driver: 'disk', diskDir: os.tmpdir() }).driver, 'disk');
        assert.equal(createObjectStorage({ driver: 'r2', r2: { bucket: 'b' }, signedUrlTtlSeconds: 60 }).driver, 'r2');
    });
});
