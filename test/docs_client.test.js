import './helpers/env.js';
// Colas encendidas solo para esta prueba: el ejecutor de la cola se inyecta y no se abre ninguna conexion.
process.env.QUEUE_ENABLED = 'true';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Dinamico: los import estaticos se evaluan antes que la linea de arriba, y settings lee el entorno al cargarse.
const { createDiskStorage } = await import('#Libs/object_storage.js');
const { DocsUnavailableError, printOutputHash, printPdf } = await import('#Libs/docs_client.js');

const PDF = Buffer.from('%PDF-1.4 falso');
const input = { html: '<p>hola</p>', title: 'Lista' };

describe('printPdf (cliente de edk-docs en la API)', () => {
    let dir;
    let storage;
    before(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'edk-docs-client-'));
        storage = createDiskStorage({ rootDir: dir });
    });
    after(() => fsp.rm(dir, { recursive: true, force: true }));

    const outputKey = (html) => `pdf/print/${printOutputHash({ html, title: input.title, headerFooter: true, watermark: true })}.pdf`;
    const unique = () => ({ ...input, html: `<p>${Math.random()}</p>` });

    it('devuelve el PDF que dejo el trabajo y pide impresion autocontenida', async () => {
        const doc = unique();
        let seen = null;
        const runner = {
            run: async ({ data }) => { seen = data; await storage.put(data.output_key, PDF); },
            discard: async () => assert.fail('no hacia falta descartar'),
        };
        assert.deepEqual(await printPdf(doc, { storage, runner }), PDF);
        assert.equal(seen.self_contained, true);
    });

    it('un PDF ya impreso sale del almacenamiento sin encolar', async () => {
        const doc = unique();
        await storage.put(outputKey(doc.html), PDF);
        const runner = { run: async () => assert.fail('no debia encolar'), discard: async () => {} };
        assert.deepEqual(await printPdf(doc, { storage, runner }), PDF);
    });

    it('un trabajo que falla deja pasar DocsUnavailableError (la lista cae al PDF de texto), no un error comun', async () => {
        const runner = { run: async () => { throw new DocsUnavailableError('el trabajo fallo: Chromium no esta configurado'); }, discard: async () => {} };
        await assert.rejects(printPdf(unique(), { storage, runner }), DocsUnavailableError);
    });

    it('si el trabajo termino pero su PDF se borro, descarta el trabajo y lo rehace una vez', async () => {
        const doc = unique();
        const calls = [];
        const runner = {
            run: async ({ data }) => {
                calls.push('run');
                // Primera vuelta: el trabajo "termino" pero no hay PDF. Segunda: imprime de verdad.
                if (calls.filter((call) => call === 'run').length === 2) {
                    assert.ok(await storage.exists(data.html_key), 'la entrada se vuelve a subir');
                    await storage.put(data.output_key, PDF);
                }
            },
            discard: async () => { calls.push('discard'); },
        };
        assert.deepEqual(await printPdf(doc, { storage, runner }), PDF);
        assert.deepEqual(calls, ['run', 'discard', 'run']);
    });

    it('si tras rehacerlo sigue sin PDF, DocsUnavailableError', async () => {
        const runner = { run: async () => {}, discard: async () => {} };
        await assert.rejects(printPdf(unique(), { storage, runner }), DocsUnavailableError);
    });
});
