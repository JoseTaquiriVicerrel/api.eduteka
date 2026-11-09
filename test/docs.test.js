import './helpers/env.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PDFDocument } from 'pdf-lib';
import { UnrecoverableError } from 'bullmq';
import { createBrowserManager, ChromiumUnavailableError } from '#Modules/docs/chromium.js';
import { createDocsHandlers } from '#Modules/docs/docs.handlers.js';
import { addWatermark, printHtml } from '#Modules/docs/print.js';
import { DocxEngineUnavailableError, convertDocx } from '#Modules/docs/docx.js';
import { createDiskStorage } from '#Libs/object_storage.js';
import { CONTRACT_VERSION, InvalidJobError, QUEUES, validateJob } from '#Libs/queue_contracts.js';

// Chromium real para la prueba de impresion: el que trae el monolito en desarrollo, o DOCS_CHROMIUM_PATH.
const LOCAL_CHROME = [
    process.env.DOCS_TEST_CHROMIUM,
    'E:\\Trabajo\\eduteka\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
].find((candidate) => candidate && fs.existsSync(candidate));

const blankPdf = async (pages = 1) => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < pages; i += 1) pdf.addPage([595, 842]);
    return Buffer.from(await pdf.save());
};

// Navegador simulado: cuenta paginas y cierres; `connected` se puede apagar para simular una caida.
const fakeLaunch = () => {
    const launched = [];
    const launch = async () => {
        const browser = new EventEmitter();
        browser.connected = true;
        browser.closed = false;
        browser.pages = 0;
        browser.newPage = async () => { browser.pages += 1; return { close: async () => {} }; };
        browser.close = async () => { browser.closed = true; browser.connected = false; };
        launched.push(browser);
        return browser;
    };
    return { launch, launched };
};

describe('contrato de la cola docs', () => {
    const print = (overrides = {}) => ({
        v: CONTRACT_VERSION, html_key: 'docs/in/ab.html', output_key: 'pdf/ab.pdf', title: 'Examen', header_footer: true, watermark: true, ...overrides,
    });

    it('acepta claves validas y rechaza recorridos', () => {
        assert.ok(validateJob(QUEUES.DOCS, 'print-pdf', print()));
        for (const bad of ['../x.html', 'docs/../x.html', 'docs/./x.html', 'docs/..', '..', '.', 'a//b', 'a\\b']) {
            assert.throws(() => validateJob(QUEUES.DOCS, 'print-pdf', print({ html_key: bad })), InvalidJobError, bad);
        }
        for (const good of ['docs/in/a.b.html', 'pdf/.hidden-not', 'pdf/a..b.pdf', 'x']) {
            assert.ok(validateJob(QUEUES.DOCS, 'print-pdf', print({ html_key: good })), good);
        }
        assert.throws(() => validateJob(QUEUES.DOCS, 'print-pdf', print({ output_key: '/pdf/x.pdf' })), InvalidJobError);
        assert.ok(validateJob(QUEUES.DOCS, 'docx-pdf', { v: CONTRACT_VERSION, docx_key: 'docs/in/m.docx', output_key: 'pdf/m.pdf' }));
    });
});

describe('navegador compartido', () => {
    it('sin Chromium configurado falla con ChromiumUnavailableError', async () => {
        const manager = createBrowserManager({ executablePath: null });
        await assert.rejects(manager.withPage(async () => {}), ChromiumUnavailableError);
    });

    it('reutiliza un solo navegador y lo reemplaza cada maxJobs documentos', async () => {
        const { launch, launched } = fakeLaunch();
        const manager = createBrowserManager({ executablePath: 'x', maxJobs: 3, launch });
        for (let i = 0; i < 7; i += 1) await manager.withPage(async () => {});
        assert.equal(launched.length, 3, '7 documentos con tope 3: 3 navegadores');
        assert.deepEqual(launched.map((browser) => browser.pages), [3, 3, 1]);
        assert.deepEqual(launched.map((browser) => browser.closed), [true, true, false], 'los retirados se cierran');
        await manager.close();
        assert.equal(launched[2].closed, true);
    });

    it('el navegador viejo espera a que terminen sus documentos antes de cerrarse', async () => {
        const { launch, launched } = fakeLaunch();
        const manager = createBrowserManager({ executablePath: 'x', maxJobs: 1, launch });
        let release;
        const slow = manager.withPage(() => new Promise((resolve) => { release = resolve; }));
        await new Promise((resolve) => setImmediate(resolve));
        await manager.withPage(async () => {}); // fuerza el reemplazo mientras el primero sigue abierto
        assert.equal(launched[0].closed, false, 'no se cierra con un documento en curso');
        release();
        await slow;
        assert.equal(launched[0].closed, true);
        await manager.close();
    });

    it('si Chromium se cae, el proximo documento lanza otro', async () => {
        const { launch, launched } = fakeLaunch();
        const manager = createBrowserManager({ executablePath: 'x', maxJobs: 100, launch });
        await manager.withPage(async () => {});
        launched[0].connected = false;
        launched[0].emit('disconnected');
        await manager.withPage(async () => {});
        assert.equal(launched.length, 2);
        await manager.close();
    });
});

describe('manejadores de la cola docs', () => {
    let root;
    let storage;
    before(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'edk-docs-'));
        storage = createDiskStorage({ rootDir: root });
    });
    after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const printer = { calls: 0, withPage: async (fn) => { printer.calls += 1; return fn({
        setContent: async () => {},
        pdf: async () => blankPdf(2),
    }); } };

    it('print-pdf: imprime, guarda la salida, borra la entrada y devuelve las paginas', async () => {
        await storage.put('docs/in/a.html', Buffer.from('<p>hola</p>'));
        const handlers = createDocsHandlers({ browserManager: printer, storage });
        const result = await handlers['print-pdf']({ data: { html_key: 'docs/in/a.html', output_key: 'pdf/a.pdf', title: 'T', header_footer: true, watermark: true } });
        assert.deepEqual([result.key, result.pages, result.cached], ['pdf/a.pdf', 2, false]);
        assert.equal(await storage.exists('pdf/a.pdf'), true);
        assert.equal(await storage.exists('docs/in/a.html'), false);
    });

    it('print-pdf: con la salida ya impresa no vuelve a imprimir', async () => {
        const before = printer.calls;
        const handlers = createDocsHandlers({ browserManager: printer, storage });
        const result = await handlers['print-pdf']({ data: { html_key: 'docs/in/a.html', output_key: 'pdf/a.pdf', title: '', header_footer: false, watermark: false } });
        assert.equal(result.cached, true);
        assert.equal(printer.calls, before);
    });

    it('sin la entrada, o sin motor, falla sin reintentos', async () => {
        const handlers = createDocsHandlers({ browserManager: createBrowserManager({ executablePath: null }), storage, docx: () => Promise.reject(new DocxEngineUnavailableError()) });
        await assert.rejects(handlers['print-pdf']({ data: { html_key: 'docs/in/nada.html', output_key: 'pdf/n.pdf', title: '', header_footer: false, watermark: false } }), UnrecoverableError);
        await storage.put('docs/in/b.html', Buffer.from('<p>x</p>'));
        await assert.rejects(handlers['print-pdf']({ data: { html_key: 'docs/in/b.html', output_key: 'pdf/b.pdf', title: '', header_footer: false, watermark: false } }), UnrecoverableError);
        await storage.put('docs/in/m.docx', Buffer.from('PK'));
        await assert.rejects(handlers['docx-pdf']({ data: { docx_key: 'docs/in/m.docx', output_key: 'pdf/m.pdf' } }), UnrecoverableError);
    });

    it('docx-pdf: convierte con el conversor y guarda el PDF', async () => {
        await storage.put('docs/in/m2.docx', Buffer.from('PK-docx'));
        const seen = [];
        const handlers = createDocsHandlers({ browserManager: printer, storage, docx: async (source) => { seen.push(source.toString()); return blankPdf(3); } });
        const result = await handlers['docx-pdf']({ data: { docx_key: 'docs/in/m2.docx', output_key: 'pdf/m2.pdf' } });
        assert.deepEqual(seen, ['PK-docx']);
        assert.equal(result.pages, 3);
    });
});

describe('conversion DOCX con un conversor inyectado', () => {
    it('trabaja en una carpeta temporal que se borra y devuelve el PDF', async () => {
        let workDir;
        const pdf = await convertDocx(Buffer.from('PK'), {
            convert: async (input, output) => {
                workDir = path.dirname(input);
                assert.equal(fs.readFileSync(input, 'utf8'), 'PK');
                fs.writeFileSync(output, await blankPdf(1));
            },
        });
        assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
        assert.equal(fs.existsSync(workDir), false);
    });

    it('sin motor ni conversor: DocxEngineUnavailableError', async () => {
        await assert.rejects(convertDocx(Buffer.from('PK'), { engine: null }), DocxEngineUnavailableError);
    });
});

describe('marca de agua', () => {
    it('conserva las paginas', async () => {
        const marked = await addWatermark(await blankPdf(3));
        assert.equal((await PDFDocument.load(marked)).getPageCount(), 3);
    });
});

describe('impresion real con Chromium', { skip: LOCAL_CHROME ? false : 'sin Chromium local' }, () => {
    let manager;
    before(() => { manager = createBrowserManager({ executablePath: LOCAL_CHROME, noSandbox: process.platform !== 'win32', maxJobs: 50 }); });
    after(async () => { await manager.close(); });

    it('imprime un A4 con cabecera, pie y marca de agua; el titulo se escapa', async () => {
        const html = `<html><body>${'<p>Pregunta de prueba con texto suficiente para llenar.</p>'.repeat(120)}</body></html>`;
        const pdf = await printHtml(manager, html, { title: '<script>alert(1)</script> Examen', headerFooter: true });
        const doc = await PDFDocument.load(pdf);
        assert.ok(doc.getPageCount() >= 2, `paginas: ${doc.getPageCount()}`);
        const { width, height } = doc.getPage(0).getSize();
        assert.ok(Math.abs(width - 595) < 2 && Math.abs(height - 842) < 2, `A4: ${width}x${height}`);
    });

    it('self_contained: sin JavaScript y sin red; sin la opcion, todo funciona como siempre', async () => {
        const http = await import('node:http');
        let hits = 0;
        const server = http.createServer((req, res) => { hits += 1; res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(); });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const url = `http://127.0.0.1:${server.address().port}/x.png`;
            // El script llena el documento: con JavaScript sale en varias paginas, sin el en una.
            const html = `<html><body><p>uno</p><img src="${url}"><script>for (let i = 0; i < 300; i++) document.body.append(Object.assign(document.createElement('p'), { textContent: 'linea ' + i }));</script></body></html>`;

            const sealed = await PDFDocument.load(await printHtml(manager, html, { headerFooter: false, selfContained: true }));
            assert.equal(sealed.getPageCount(), 1, 'el script no debe ejecutarse');
            assert.equal(hits, 0, 'no debe pedir nada a la red');

            const open = await PDFDocument.load(await printHtml(manager, html, { headerFooter: false }));
            assert.ok(open.getPageCount() >= 2, 'sin la opcion el script si corre');
            assert.ok(hits >= 1, 'sin la opcion la imagen si se pide');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('varios documentos a la vez en el mismo navegador', async () => {
        const docs = await Promise.all([1, 2, 3, 4].map((n) => printHtml(manager, `<p>Documento ${n}</p>`, { headerFooter: false })));
        for (const pdf of docs) assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
        assert.equal(manager.stats().running, true);
    });
});
