import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';

describe('GET /config sin metodos de pago configurados', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ PAYMENT_YAPE_NUMBER: '', PAYMENT_PLIN_NUMBER: '' });
    });
    after(() => ctx.stop());

    it('devuelve payment_methods vacio y el resto del contrato intacto', async () => {
        const res = await request(ctx.app).get('/api/v1/config').expect(200);
        assert.deepEqual(res.body.data.payment_methods, []);
        assert.equal(res.body.data.payments_enabled, true);
    });
});
