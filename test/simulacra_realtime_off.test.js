import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { seedCatalog, seedSimulacra } from './helpers/seed.js';

// settings se lee una sola vez al cargarse: el apagado va en su propio proceso (un archivo aparte).
describe('REALTIME_ENABLED=false', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp({ REALTIME_ENABLED: 'false' });
        await seedCatalog(ctx);
        await seedSimulacra(ctx);
    });
    after(() => ctx.stop());

    it('la configuracion queda apagada (server.js no llama a attachRealtime)', async () => {
        const { settings } = await import('../src/config/settings.js');
        assert.equal(settings.realtime.enabled, false);
        assert.equal(settings.realtime.path, '/api/v1/realtime');
        assert.equal(settings.realtime.maxConnectionsPerUser, 5);
    });

    it('la API sigue funcionando sin el socket', async () => {
        const res = await request(ctx.app).get('/api/v1/simulacros').expect(200);
        assert.ok(res.body.data.length > 0);
    });
});
