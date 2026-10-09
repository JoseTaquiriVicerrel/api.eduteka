import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import request from 'supertest';
import './helpers/env.js';

const { redactUrl, serializeRequest } = await import('#Libs/log_redact.js');

describe('logs sin credenciales en la URL', () => {
    it('oculta el token del enlace de descarga y deja el resto', () => {
        assert.equal(redactUrl('/api/v1/descargas/archivo?token=eyJ.abc.def'), '/api/v1/descargas/archivo?token=[oculto]');
        assert.equal(redactUrl('/x?a=1&token=SECRETO&b=2'), '/x?a=1&token=[oculto]&b=2');
        assert.equal(redactUrl('/x?TOKEN=SECRETO'), '/x?TOKEN=[oculto]');
        assert.equal(redactUrl('/api/v1/examenes?q=token'), '/api/v1/examenes?q=token', 'solo el parametro, no la palabra');
        assert.equal(redactUrl(undefined), undefined);
    });

    it('con pino-http real: el token no aparece en ninguna linea del log', async () => {
        const lines = [];
        const logger = pino({ level: 'info' }, { write: (line) => lines.push(JSON.parse(line)) });
        const app = express();
        app.use(pinoHttp({ logger, serializers: { req: serializeRequest } }));
        app.get('/api/v1/descargas/archivo', (req, res) => res.json({ ok: true }));

        await request(app).get('/api/v1/descargas/archivo?token=SECRETO-DE-DESCARGA&otro=1').expect(200);

        assert.ok(lines.length > 0, 'se registro la peticion');
        assert.equal(JSON.stringify(lines).includes('SECRETO-DE-DESCARGA'), false);
        assert.match(lines[0].req.url, /token=\[oculto\]&otro=1$/);
    });
});
