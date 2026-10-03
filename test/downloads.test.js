import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import request from 'supertest';
import { bootTestApp } from './helpers/boot.js';
import { makeFilesTree, seedDownloads } from './helpers/files.js';
import { bearer, createUser, seedCatalog, seedExams } from './helpers/seed.js';

const API = '/api/v1';
// Cuerpo binario para los archivos; los errores siguen llegando como JSON.
const binary = (res, callback) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
        const body = Buffer.concat(chunks);
        callback(null, String(res.headers['content-type']).includes('json') ? JSON.parse(body.toString('utf8')) : body);
    });
};

describe('descargas', () => {
    let ctx;
    let tree;
    let owner;
    let other;

    const premium = async (overrides = {}) => {
        const user = await createUser(ctx, overrides);
        await ctx.User.updateOne({ _id: user.session.user.id }, {
            $set: { suscription: { status: 'activo', name: 'Plan 6 meses', end_date: new Date(Date.now() + 86_400_000) } },
        });
        return user;
    };

    before(async () => {
        tree = makeFilesTree();
        ctx = await bootTestApp({ FILES_ROOT_DIR: tree.root });
        await seedCatalog(ctx);
        await seedExams(ctx);
        [owner, other] = [await createUser(ctx), await createUser(ctx)];
        await seedDownloads(ctx, owner, other);
    });
    after(async () => {
        await ctx.stop();
        tree.cleanup();
    });
    beforeEach(() => ctx.kv.flushMemory());

    const db = (name) => ctx.mongoose.connection.db.collection(name);
    const get = (route, user) => request(ctx.app).get(`${API}${route}`).set(user ? bearer(user) : {});
    const download = (route, user) => get(route, user).buffer(true).parse(binary);
    const auditRows = async (filter, { expected = 1 } = {}) => {
        // El registro de auditoria es asincrono (no retrasa la descarga): se espera a que aparezca.
        for (let i = 0; i < 40; i += 1) {
            const rows = await db('downloads').find(filter).toArray();
            if (rows.length >= expected) return rows;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return db('downloads').find(filter).toArray();
    };
    const assertNoPaths = (body) => {
        const json = JSON.stringify(body);
        for (const leaked of ['storage/', 'secret.pdf', '../outside', tree.root.replaceAll('\\', '\\\\')]) {
            assert.ok(!json.includes(leaked), `expone la ruta ${leaked}`);
        }
    };

    describe('GET /descargas (comprado)', () => {
        it('exige sesion', async () => {
            await get('/descargas').expect(401);
        });

        it('lista solo los archivos de pedidos verificados, con las areas compradas', async () => {
            const res = await get('/descargas', owner).expect(200);
            const names = res.body.data.map((file) => file.name).sort();

            // Guia (todo el producto), Examen A (solo el area comprada; no la B) y los dos archivos rotos.
            assert.deepEqual(names, ['Escape.pdf', 'Examen A.pdf', 'Falta.pdf', 'Guia.pdf']);
            assert.equal(res.body.meta.total, 4);
            assertNoPaths(res.body);
        });

        it('describe cada archivo: tamaño real, tipo, origen y enlace; los inexistentes salen como no disponibles', async () => {
            const res = await get('/descargas', owner).expect(200);
            const byName = Object.fromEntries(res.body.data.map((file) => [file.name, file]));

            const guia = byName['Guia.pdf'];
            assert.equal(guia.size, tree.files['storage/productos/guia.pdf'].length);
            assert.equal(guia.type_file, 'PDF');
            assert.equal(guia.source, 'order');
            assert.equal(guia.available, true);
            assert.equal(guia.download_url, '/api/v1/descargas/pedidos/o-verified/prod-guia/Guia');
            assert.ok(guia.id);

            assert.equal(byName['Examen A.pdf'].area, 'A');
            for (const name of ['Falta.pdf', 'Escape.pdf']) {
                assert.deepEqual([byName[name].available, byName[name].size, byName[name].download_url], [false, null, null], name);
            }
        });

        it('cada usuario ve solo lo suyo', async () => {
            const res = await get('/descargas', other).expect(200);
            assert.deepEqual(res.body.data.map((file) => file.name), ['Guia.pdf']);
            const nobody = await createUser(ctx);
            assert.deepEqual((await get('/descargas', nobody).expect(200)).body.data, []);
        });

        it('valida los parametros', async () => {
            await get('/descargas?source=otro', owner).expect(422);
            await get('/descargas?limit=51&source=exam', owner).expect(422);
        });
    });

    describe('GET /descargas/pedidos/:order/:product/:file', () => {
        const fetchFile = (order, product, file, user = owner) => download(`/descargas/pedidos/${order}/${product}/${encodeURIComponent(file)}`, user);

        it('exige sesion', async () => {
            await get('/descargas/pedidos/o-verified/prod-guia/Guia').expect(401);
        });

        it('entrega el archivo con adjunto, tamaño, soporte de Range y lo deja registrado', async () => {
            const res = await fetchFile('o-verified', 'prod-guia', 'Guia').expect(200);

            assert.equal(res.headers['content-type'], 'application/pdf');
            assert.match(res.headers['content-disposition'], /^attachment; filename="Guia\.pdf"/);
            assert.equal(res.headers['accept-ranges'], 'bytes');
            assert.equal(res.headers['cache-control'], 'no-store');
            assert.deepEqual(res.body, tree.files['storage/productos/guia.pdf']);

            const [row] = await auditRows({ user_id: owner.session.user.id, resource_id: 'prod-guia' });
            assert.equal(row.source, 'store');
            assert.equal(row.resource_type, 'product');
            assert.equal(row.order_id, 'o-verified');
            assert.equal(row.file_name, 'Guia.pdf');
        });

        it('permite descargas reanudables (Range)', async () => {
            const res = await download('/descargas/pedidos/o-verified/prod-guia/Guia', owner).set('Range', 'bytes=10-109').expect(206);
            assert.equal(res.headers['content-range'], `bytes 10-109/${tree.files['storage/productos/guia.pdf'].length}`);
            assert.deepEqual(res.body, tree.files['storage/productos/guia.pdf'].subarray(10, 110));
        });

        it('el pedido de otro usuario no existe (404), aunque se conozcan los ids', async () => {
            await fetchFile('o-other', 'prod-guia', 'Guia').expect(404);
            await fetchFile('o-verified', 'prod-guia', 'Guia', other).expect(404);
            assert.equal((await db('downloads').countDocuments({ user_id: other.session.user.id })), 0);
        });

        it('un pedido propio sin verificar o rechazado -> 403', async () => {
            const pending = await fetchFile('o-pending', 'prod-unico', 'Unico').expect(403);
            assert.equal(pending.body.error.code, 'FORBIDDEN');
            await fetchFile('o-rejected', 'prod-guia', 'Guia').expect(403);
        });

        it('un examen vendido por areas solo da las areas compradas (403 para la B)', async () => {
            await fetchFile('o-verified', 'prod-examen', 'Examen A').expect(200);
            const refused = await fetchFile('o-verified', 'prod-examen', 'Examen B').expect(403);
            assert.match(refused.body.error.message, /área/);
        });

        it('producto que no esta en el pedido, archivo inexistente o pedido inexistente -> 404', async () => {
            await fetchFile('o-verified', 'prod-unico', 'Unico').expect(404);
            await fetchFile('o-verified', 'prod-guia', 'Otro').expect(404);
            await fetchFile('no-existe', 'prod-guia', 'Guia').expect(404);
        });

        it('si el archivo falta en el servidor -> 404; una ruta que intenta salir de la raiz nunca se lee', async () => {
            const missing = await fetchFile('o-verified', 'prod-roto', 'Falta').expect(404);
            assert.match(missing.body.error.message, /ya no está disponible/);

            const escape = await fetchFile('o-verified', 'prod-roto', 'Escape').expect(404);
            assert.ok(!Buffer.from(JSON.stringify(escape.body)).includes('TOP SECRET'));
            assert.equal(await db('downloads').countDocuments({ resource_id: 'prod-roto' }), 0);
        });
    });

    describe('GET /descargas?source=exam y GET /examenes/:slug/pdf', () => {
        it('sin suscripcion no se listan ni se descargan (403 SUBSCRIPTION_REQUIRED)', async () => {
            const free = await createUser(ctx);
            const list = await get('/descargas?source=exam', free).expect(403);
            assert.equal(list.body.error.code, 'SUBSCRIPTION_REQUIRED');
            const pdf = await get('/examenes/unmsm-2025-i/pdf', free).expect(403);
            assert.equal(pdf.body.error.code, 'SUBSCRIPTION_REQUIRED');
            await get('/examenes/unmsm-2025-i/pdf').expect(401);
        });

        it('una suscripcion vencida (el cron aun no la marco) tampoco da acceso', async () => {
            const expired = await createUser(ctx);
            await ctx.User.updateOne({ _id: expired.session.user.id }, { $set: { suscription: { status: 'activo', end_date: new Date(Date.now() - 1000) } } });
            await get('/examenes/unmsm-2025-i/pdf', expired).expect(403);
        });

        it('con suscripcion: entrega el PDF del examen (primer cuadernillo con archivo) y audita', async () => {
            const user = await premium();
            const res = await download('/examenes/unmsm-2025-i/pdf', user).expect(200);

            assert.deepEqual(res.body, tree.files['storage/examenes/e1-a.pdf']);
            assert.match(res.headers['content-disposition'], /filename="e1-a\.pdf"/);

            const [row] = await auditRows({ user_id: user.session.user.id });
            assert.equal(row.source, 'subscription');
            assert.equal(row.resource_type, 'exam');
            assert.equal(row.resource_slug, 'unmsm-2025-i');
            assert.equal(row.area, 'A');
            assert.equal(row.subscription.name, 'Plan 6 meses');
        });

        it('el cuadernillo se elige con ?area=; uno sin archivo, que escapa de la raiz o inexistente -> 404', async () => {
            const user = await premium();
            await download('/examenes/unmsm-2025-i/pdf?area=A', user).expect(200);
            await download('/examenes/unmsm-2025-i/pdf?area=B', user).expect(404); // la ruta sale de la raiz
            await download('/examenes/unmsm-2025-i/pdf?area=Z', user).expect(404);
            await download('/examenes/unmsm-2024-ii/pdf', user).expect(404); // archivo ausente en disco
            await download('/examenes/antigua-2023/pdf', user).expect(404); // sin archivos
            await download('/examenes/borrador/pdf', user).expect(404); // no publicado
            await download('/examenes/no-existe/pdf', user).expect(404);
        });

        it('un plan restringido a otra institucion no descarga (403 INSTITUTION_RESTRICTED)', async () => {
            const user = await createUser(ctx);
            await ctx.User.updateOne({ _id: user.session.user.id }, { $set: {
                suscription: { status: 'activo', restricted_to_institution: true, institution_id: 'inst-antigua', end_date: new Date(Date.now() + 86_400_000) },
            } });
            const res = await get('/examenes/unmsm-2025-i/pdf', user).expect(403);
            assert.equal(res.body.error.code, 'INSTITUTION_RESTRICTED');
        });

        it('el administrador descarga sin suscripcion; el registro no lleva plan', async () => {
            const admin = await createUser(ctx);
            await ctx.User.updateOne({ _id: admin.session.user.id }, { $set: { rol: 'Administrador' } });
            await download('/examenes/unmsm-2025-i/pdf', admin).expect(200);
            const [row] = await auditRows({ user_id: admin.session.user.id });
            assert.equal(row.user_rol, 'Administrador');
            assert.ok(!row.subscription);
        });

        it('lista los examenes con archivo: tamaño real, no disponibles marcados y sin rutas', async () => {
            const user = await premium();
            const res = await get('/descargas?source=exam', user).expect(200);
            const byArea = Object.fromEntries(res.body.data.map((file) => [`${file.exam.slug}:${file.area}`, file]));

            const a = byArea['unmsm-2025-i:A'];
            assert.equal(a.name, 'Examen UNMSM 2025-I - Cuadernillo A');
            assert.equal(a.size, tree.files['storage/examenes/e1-a.pdf'].length);
            assert.equal(a.source, 'exam');
            assert.equal(a.download_url, '/api/v1/examenes/unmsm-2025-i/pdf?area=A');
            assert.equal(byArea['unmsm-2025-i:B'].available, false);
            assert.equal(byArea['unmsm-2024-ii:I'].available, false);
            assertNoPaths(res.body);
            assert.deepEqual(res.body.meta, { page: 1, limit: 20, total: 2, has_more: false });
        });

        it('filtra por institucion, modalidad y titulo; un plan restringido solo lista su institucion', async () => {
            const user = await premium();
            const byInstitution = await get('/descargas?source=exam&institution=inst-antigua', user).expect(200);
            assert.deepEqual(byInstitution.body.data, []);
            const byModality = await get('/descargas?source=exam&modality=Extraordinario', user).expect(200);
            assert.deepEqual(byModality.body.data.map((file) => file.exam.slug), ['unmsm-2024-ii']);
            const byTitle = await get('/descargas?source=exam&q=2025', user).expect(200);
            assert.deepEqual([...new Set(byTitle.body.data.map((file) => file.exam.slug))], ['unmsm-2025-i']);

            const locked = await createUser(ctx);
            await ctx.User.updateOne({ _id: locked.session.user.id }, { $set: {
                suscription: { status: 'activo', restricted_to_institution: true, institution_id: 'inst-antigua', end_date: new Date(Date.now() + 86_400_000) },
            } });
            // Aunque pida otra institucion, solo ve la de su plan (que no tiene archivos).
            const lockedList = await get('/descargas?source=exam&institution=inst-unmsm', locked).expect(200);
            assert.deepEqual(lockedList.body.data, []);
        });
    });

    describe('enlaces firmados de 60 s (DownloadManager)', () => {
        const idOf = async (user, name) => (await get('/descargas', user).expect(200)).body.data.find((file) => file.name === name).id;
        const link = (id, user) => request(ctx.app).post(`${API}/descargas/${id}/enlace`).set(user ? bearer(user) : {});
        const redeem = (url) => request(ctx.app).get(new URL(url, 'http://localhost').pathname + new URL(url, 'http://localhost').search).buffer(true).parse(binary);

        it('exige sesion para pedirlo; un id invalido es 404', async () => {
            await link('abc', null).expect(401);
            await link('no-es-una-referencia', owner).expect(404);
            await link(Buffer.from('{"k":"x"}').toString('base64url'), owner).expect(404);
        });

        it('se canjea SIN Bearer y entrega el archivo; deja registrado al usuario correcto', async () => {
            const res = await link(await idOf(owner, 'Guia.pdf'), owner).expect(200);
            assert.equal(res.body.data.expires_in, 60);
            assert.match(res.body.data.url, /^\/api\/v1\/descargas\/archivo\?token=/);

            const file = await redeem(res.body.data.url).expect(200);
            assert.deepEqual(file.body, tree.files['storage/productos/guia.pdf']);
            const rows = await auditRows({ user_id: owner.session.user.id, resource_id: 'prod-guia' }, { expected: 1 });
            assert.ok(rows.length >= 1);
        });

        it('funciona tambien para el PDF de un examen de la suscripcion', async () => {
            const user = await premium();
            const id = (await get('/descargas?source=exam', user).expect(200)).body.data.find((file) => file.area === 'A').id;
            const res = await link(id, user).expect(200);
            const file = await redeem(res.body.data.url).expect(200);
            assert.deepEqual(file.body, tree.files['storage/examenes/e1-a.pdf']);
        });

        it('no se puede pedir el enlace de un archivo al que no se tiene derecho', async () => {
            // El id apunta al pedido de OTRO usuario: 404 (no se revela que existe) y no se firma nada.
            const othersId = await idOf(other, 'Guia.pdf');
            await link(othersId, owner).expect(404);

            // Un examen de la suscripcion sin tener suscripcion: 403.
            const premiumUser = await premium();
            const examId = (await get('/descargas?source=exam', premiumUser).expect(200)).body.data.find((file) => file.area === 'A').id;
            await link(examId, other).expect(403);
        });

        it('el derecho se vuelve a comprobar al canjear (el pedido se rechazo entre medias)', async () => {
            const id = await idOf(owner, 'Examen A.pdf');
            const res = await link(id, owner).expect(200);
            await db('orders').updateOne({ _id: 'o-verified' }, { $set: { status: 'rejected' } });
            try {
                const refused = await redeem(res.body.data.url).expect(403);
                assert.equal(refused.body.error.code, "FORBIDDEN");
            } finally {
                await db('orders').updateOne({ _id: 'o-verified' }, { $set: { status: 'verified' } });
            }
        });

        it('un token vencido, de otro tipo o manipulado se rechaza (401)', async () => {
            const secret = new TextEncoder().encode(process.env.JWT_SECRET);
            const sign = (claims, expires = '60s') => new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setIssuer('eduteka-api').setExpirationTime(expires).sign(secret);
            const ref = await idOf(owner, 'Guia.pdf');

            const expired = await new SignJWT({ uid: owner.session.user.id, ref, typ: 'download' })
                .setProtectedHeader({ alg: 'HS256' }).setIssuedAt(Math.floor(Date.now() / 1000) - 600).setIssuer('eduteka-api')
                .setExpirationTime(Math.floor(Date.now() / 1000) - 300).sign(secret);
            await request(ctx.app).get(`${API}/descargas/archivo?token=${expired}`).expect(401);

            // Un access token (typ distinto) no sirve como enlace.
            await request(ctx.app).get(`${API}/descargas/archivo?token=${owner.session.access_token}`).expect(401);
            const asAccess = await sign({ uid: owner.session.user.id, ref, typ: 'access' });
            await request(ctx.app).get(`${API}/descargas/archivo?token=${asAccess}`).expect(401);

            const ok = await sign({ uid: owner.session.user.id, ref, typ: 'download' });
            await request(ctx.app).get(`${API}/descargas/archivo?token=${ok}x`).expect(401);
            await request(ctx.app).get(`${API}/descargas/archivo`).expect(422);
            await request(ctx.app).get(`${API}/descargas/archivo?token=corto`).expect(422);
        });

        it('un enlace de un usuario desactivado o eliminado no sirve', async () => {
            const user = await premium();
            const id = (await get('/descargas?source=exam', user).expect(200)).body.data.find((file) => file.area === 'A').id;
            const res = await link(id, user).expect(200);
            await ctx.User.updateOne({ _id: user.session.user.id }, { $set: { state: false } });
            await redeem(res.body.data.url).expect(401);
        });
    });

    describe('GET /perfil/recursos', () => {
        it('exige sesion', async () => {
            await get('/perfil/recursos').expect(401);
        });

        it('compras (verificadas y pendientes) con sus archivos y el estado de la suscripcion', async () => {
            const res = await get('/perfil/recursos', owner).expect(200);
            const { orders, subscription } = res.body.data;

            assert.deepEqual(orders.map((order) => [order.id, order.status]), [['o-verified', 'verified'], ['o-pending', 'pending']]);
            const verified = orders[0];
            assert.deepEqual(verified.items.map((item) => item.product.id), ['prod-guia', 'prod-examen', 'prod-roto']);
            assert.deepEqual(verified.items[1].areas, ['A']);
            assert.deepEqual(verified.items[1].files.map((file) => file.name), ['Examen A.pdf']);
            assert.equal(verified.items[0].files[0].available, true);

            // Los archivos de un pedido pendiente se muestran, pero sin enlace.
            const pendingFile = orders[1].items[0].files[0];
            assert.deepEqual([pendingFile.name, pendingFile.available, pendingFile.download_url], ['Unico.pdf', false, null]);

            assert.deepEqual(subscription, { active: false, plan_name: null, end_date: null, locked_institution: null, exams_url: null });
            assertNoPaths(res.body);
        });

        it('con suscripcion indica el plan y donde listar los examenes', async () => {
            const user = await premium();
            const { subscription } = (await get('/perfil/recursos', user).expect(200)).body.data;
            assert.equal(subscription.active, true);
            assert.equal(subscription.plan_name, 'Plan 6 meses');
            assert.equal(subscription.exams_url, '/api/v1/descargas?source=exam');
            assert.ok(subscription.end_date);
        });
    });
});
