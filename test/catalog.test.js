import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { seedCatalog } from './helpers/seed.js';

describe('catalogo: instituciones y areas', () => {
    let ctx;
    before(async () => {
        ctx = await bootTestApp();
        await seedCatalog(ctx);
    });
    after(() => ctx.stop());

    const get = (path) => request(ctx.app).get(`/api/v1${path}`);

    it('GET /instituciones: activas y antiguas sin state; oculta las desactivadas; ordenadas por nombre', async () => {
        const res = await get('/instituciones').expect(200);
        const ids = res.body.data.map((institution) => institution.id);

        assert.deepEqual(ids, ['inst-antigua', 'inst-unmsm']);
        const unmsm = res.body.data.find((institution) => institution.id === 'inst-unmsm');
        assert.equal(unmsm.image, 'https://eduteka.test/images/inst/sm.png');
        assert.equal(unmsm.exams_count, 12);
        assert.equal(unmsm.departament, 'Lima');
        // Sin campos internos.
        assert.deepEqual(Object.keys(unmsm).sort(), ['abrev', 'departament', 'exams_count', 'id', 'image', 'name', 'province']);
    });

    it('los catalogos son cacheables y responden 304 si no cambiaron (ETag)', async () => {
        const first = await get('/instituciones').expect(200);
        assert.equal(first.headers['cache-control'], 'public, max-age=300');
        assert.ok(first.headers.etag);

        await get('/instituciones').set('If-None-Match', first.headers.etag).expect(304);
    });

    it('GET /areas: cuenta solo preguntas practicables, ordena por volumen y omite areas vacias', async () => {
        const res = await get('/areas').expect(200);

        // Matematica: q1, q2, q3, q8 (q4 sin verificar, q5 de docente y q6 sin clave no cuentan).
        assert.deepEqual(res.body.data, [
            { id: 'area-mat', name: 'Matemática', slug: 'matematica', count: 4 },
            { id: 'area-len', name: 'Lenguaje', slug: 'lenguaje', count: 1 },
        ]);
    });

    it('GET /areas?institution= cuenta solo las preguntas de esa institucion', async () => {
        const res = await get('/areas?institution=inst-unmsm').expect(200);
        assert.deepEqual(res.body.data, [{ id: 'area-mat', name: 'Matemática', slug: 'matematica', count: 1 }]);
    });

    it('GET /areas?with_resolution=true cuenta solo las que traen explicacion', async () => {
        const res = await get('/areas?with_resolution=true').expect(200);
        assert.deepEqual(res.body.data, [{ id: 'area-mat', name: 'Matemática', slug: 'matematica', count: 1 }]);
    });

    it('rechaza filtros desconocidos con 422', async () => {
        const res = await get('/areas?institucion=x').expect(422);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
        await get('/areas?with_resolution=quizas').expect(422);
    });
});
