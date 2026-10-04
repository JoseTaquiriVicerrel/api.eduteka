import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp-compact';
import './helpers/env.js';

// Proveedor `gemini` del lector de comprobantes, con `fetch` simulado (sin red).
// Archivo propio: la configuracion se lee una vez por proceso.
Object.assign(process.env, { PAYMENT_AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'clave-de-prueba', PAYMENT_AI_MODEL: 'gemini-test' });

describe('lector de comprobantes con Gemini', () => {
    const realFetch = globalThis.fetch;
    let readVoucher;
    let png;
    let calls;

    const respond = (status, body) => async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };
    const answer = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });

    before(async () => {
        ({ readVoucher } = await import('#Modules/payments/voucher.reader.js'));
        png = await new Jimp(10, 10, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
    });
    after(() => { globalThis.fetch = realFetch; });

    it('envia la imagen con su tipo, la clave en la cabecera y pide JSON', async () => {
        calls = [];
        globalThis.fetch = respond(200, answer('{"monto": 15, "fecha": "2026-10-02", "receptor": "Eduteka", "numero_operacion": "00123"}'));
        const result = await readVoucher(png);

        assert.deepEqual(result, { monto: 15, fecha: '2026-10-02', receptor: 'Eduteka', numero_operacion: '00123' });
        const [{ url, init, body }] = calls;
        assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
        assert.equal(init.headers['x-goog-api-key'], 'clave-de-prueba');
        assert.equal(url.includes('clave-de-prueba'), false);
        assert.equal(body.contents[0].parts[0].inline_data.mime_type, 'image/png');
        assert.equal(body.contents[0].parts[0].inline_data.data, png.toString('base64'));
        assert.equal(body.generationConfig.responseMimeType, 'application/json');
    });

    it('acepta la respuesta envuelta en un bloque de codigo', async () => {
        calls = [];
        globalThis.fetch = respond(200, answer('```json\n{"monto": "S/ 40.00", "fecha": null, "numero_operacion": null}\n```'));
        assert.deepEqual(await readVoucher(png), { monto: 40, fecha: null, receptor: null, numero_operacion: null });
    });

    it('un error HTTP, un JSON roto o un fallo de red devuelven null (revision manual)', async () => {
        calls = [];
        globalThis.fetch = respond(429, { error: { message: 'quota' } });
        assert.equal(await readVoucher(png), null);

        globalThis.fetch = respond(200, answer('no es json'));
        assert.equal(await readVoucher(png), null);

        globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
        assert.equal(await readVoucher(png), null);
    });
});
