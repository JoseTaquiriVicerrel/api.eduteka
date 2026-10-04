import './helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { compareVersions } from '#Libs/semver.js';
import { CAPABILITIES, capabilitiesFor, hasActiveSuscription, isPremium } from '#Libs/capabilities.js';
import { ApiError } from '#Libs/api_error.js';
import authorize, { requireSubscription } from '#Middlewares/authorize.js';
import validate from '#Middlewares/validate.js';
import { generateCode, hashCode, safeEqual } from '#Libs/tokens.js';
import { serializeSuscription, serializeUser } from '#Serializers/user.serializer.js';

// Ejecuta un middleware y devuelve el error que pasa a next() (o null).
const run = (middleware, req) => new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error ?? null));
});

describe('compareVersions', () => {
    it('compara x.y.z numericamente (no como texto)', () => {
        assert.equal(compareVersions('1.4.2', '1.4.2'), 0);
        assert.equal(compareVersions('1.4.2', '1.10.0'), -1);
        assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
        assert.equal(compareVersions('1.4.10', '1.4.9'), 1);
    });
    it('devuelve null si no se puede leer', () => {
        assert.equal(compareVersions('abc', '1.0.0'), null);
        assert.equal(compareVersions(undefined, '1.0.0'), null);
    });
});

describe('capacidades', () => {
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);

    it('estudiante, profesor y administrador', () => {
        const student = capabilitiesFor({ rol: 'User', account_type: 'Estudiante' });
        for (const cap of ['answer_questions', 'take_practice', 'take_simulacrum', 'track_progress', 'buy_materials', 'download_materials']) assert.ok(student.includes(cap), cap);
        assert.ok(!student.includes(CAPABILITIES.VIEW_ANSWERS_DIRECTLY));
        assert.ok(!student.includes(CAPABILITIES.MANAGE_MATERIALS));

        const teacher = capabilitiesFor({ rol: 'User', account_type: 'Profesor' });
        assert.deepEqual(teacher.sort(), ['buy_materials', 'create_practice', 'download_materials', 'manage_materials', 'manage_questions', 'manage_templates', 'view_answers_directly']);

        const admin = capabilitiesFor({ rol: 'Administrador' });
        assert.ok(admin.includes(CAPABILITIES.TAKE_SIMULACRUM) && admin.includes(CAPABILITIES.MANAGE_TEMPLATES));
        assert.ok(!admin.includes(CAPABILITIES.VIEW_ANSWERS_DIRECTLY));
    });
    it('una cuenta sin tipo se trata como estudiante', () => {
        assert.ok(capabilitiesFor({ rol: 'User' }).includes(CAPABILITIES.TAKE_PRACTICE));
    });
    it('premium exige estado activo Y no vencida; sin end_date es vitalicia', () => {
        assert.equal(hasActiveSuscription({ suscription: { status: 'activo', end_date: future } }), true);
        assert.equal(hasActiveSuscription({ suscription: { status: 'activo', end_date: past } }), false);
        assert.equal(hasActiveSuscription({ suscription: { status: 'activo', end_date: null } }), true);
        assert.equal(hasActiveSuscription({ suscription: { status: 'Finalizado', end_date: future } }), false);
        assert.equal(hasActiveSuscription({}), false);
        assert.equal(isPremium({ rol: 'Administrador' }), true);
    });
    it('serializeSuscription: sin plan -> null; con plan calcula dias', () => {
        assert.equal(serializeSuscription(undefined), null);
        const now = new Date('2026-01-01T00:00:00Z');
        const result = serializeSuscription({ status: 'activo', end_date: new Date('2026-01-11T00:00:00Z') }, now);
        assert.equal(result.days_remaining, 10);
        assert.equal(result.active, true);
    });
    it('serializeSuscription: can_renew es false solo si ya hay una renovación encadenada que no empieza', () => {
        const now = new Date('2026-01-01T00:00:00Z');
        const running = { status: 'activo', start_date: new Date('2025-12-01T00:00:00Z'), end_date: new Date('2026-06-01T00:00:00Z') };
        const queued = { status: 'activo', start_date: new Date('2026-06-01T00:00:00Z'), end_date: new Date('2026-12-01T00:00:00Z') };
        const expired = { status: 'Finalizado', start_date: new Date('2025-01-01T00:00:00Z'), end_date: new Date('2025-07-01T00:00:00Z') };
        const noStart = { status: 'activo', end_date: new Date('2026-06-01T00:00:00Z') };

        assert.equal(serializeSuscription(running, now).can_renew, true);
        assert.equal(serializeSuscription(queued, now).can_renew, false);
        assert.equal(serializeSuscription(expired, now).can_renew, true);
        assert.equal(serializeSuscription(noStart, now).can_renew, true);
    });
    it('serializeUser no filtra campos internos', () => {
        const user = serializeUser({
            _id: 'u1', email: 'a@b.co', password: 'hash', token_verify: 'x', token_recovery_verify: 'y',
            password_reset_jti: 'z', dni: '12345678', isVerified: true, rol: 'User',
        });
        const json = JSON.stringify(user);
        for (const secret of ['hash', 'token_verify', 'token_recovery', 'password_reset_jti', '12345678']) {
            assert.ok(!json.includes(secret), `filtra ${secret}`);
        }
        assert.equal(user.id, 'u1');
        assert.equal(user.is_verified, true);
    });
    it('el avatar relativo se vuelve absoluto con la URL publica', () => {
        assert.equal(serializeUser({ _id: 'u', avatar: '/uploads/avatars/a.png' }).avatar, 'https://eduteka.test/uploads/avatars/a.png');
        assert.equal(serializeUser({ _id: 'u', avatar: 'https://cdn.x/a.png' }).avatar, 'https://cdn.x/a.png');
        assert.equal(serializeUser({ _id: 'u' }).avatar, null);
    });
});

describe('authorize / requireSubscription', () => {
    it('sin sesion -> 401; usuario desactivado -> 403 ACCOUNT_DISABLED', async () => {
        assert.equal((await run(authorize(), { user: null, authError: 'missing' })).status, 401);
        assert.equal((await run(authorize(), { user: null, authError: 'invalid' })).code, 'UNAUTHENTICATED');
        assert.equal((await run(authorize(), { user: null, authError: 'disabled' })).code, 'ACCOUNT_DISABLED');
    });
    it('sin roles basta con tener sesion', async () => {
        assert.equal(await run(authorize(), { user: { rol: 'User' } }), null);
    });
    it('acepta rol o tipo de cuenta; el administrador siempre pasa', async () => {
        const teacher = { rol: 'User', account_type: 'Profesor' };
        assert.equal(await run(authorize('Profesor'), { user: teacher }), null);
        assert.equal((await run(authorize('Administrador'), { user: teacher })).code, 'FORBIDDEN');
        assert.equal(await run(authorize('Profesor'), { user: { rol: 'Administrador' } }), null);
    });
    it('requireSubscription: 403 SUBSCRIPTION_REQUIRED sin plan activo o vencido', async () => {
        const mw = requireSubscription();
        assert.equal((await run(mw, { user: { rol: 'User' } })).code, 'SUBSCRIPTION_REQUIRED');
        const expired = { rol: 'User', suscription: { status: 'activo', end_date: new Date(Date.now() - 1000) } };
        assert.equal((await run(mw, { user: expired })).code, 'SUBSCRIPTION_REQUIRED');
        const active = { rol: 'User', suscription: { status: 'activo', end_date: new Date(Date.now() + 100000) } };
        assert.equal(await run(mw, { user: active }), null);
        assert.equal(await run(mw, { user: { rol: 'Administrador' } }), null);
    });
    it('requireSubscription: plan limitado a otra institucion -> INSTITUTION_RESTRICTED', async () => {
        const mw = requireSubscription({ institutionOf: (req) => req.institution });
        const user = { rol: 'User', suscription: { status: 'activo', restricted_to_institution: true, institution_id: 'A' } };
        assert.equal((await run(mw, { user, institution: 'B' })).code, 'INSTITUTION_RESTRICTED');
        assert.equal(await run(mw, { user, institution: 'A' }), null);
    });
});

describe('validate', () => {
    const Query = Type.Object({
        page: Type.Integer({ minimum: 1, default: 1 }),
        limit: Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
        q: Type.Optional(Type.String({ maxLength: 10 })),
    }, { additionalProperties: false });

    it('query: convierte texto a numero y aplica valores por defecto', async () => {
        const req = { query: { page: '3' } };
        assert.equal(await run(validate(Query, 'query'), req), null);
        assert.deepEqual(req.query, { page: 3, limit: 20 });
    });
    it('query: limit fuera de rango -> 422 con el campo', async () => {
        const error = await run(validate(Query, 'query'), { query: { limit: '500' } });
        assert.equal(error.status, 422);
        assert.deepEqual(error.details.map((detail) => detail.field), ['limit']);
    });
    it('body: NO convierte tipos ("5" no es un entero)', async () => {
        const Body = Type.Object({ n: Type.Integer() }, { additionalProperties: false });
        const error = await run(validate(Body), { body: { n: '5' } });
        assert.equal(error.code, 'VALIDATION_ERROR');
    });
    it('body: campos extra rechazados y no se modifica el objeto original', async () => {
        const Body = Type.Object({ a: Type.String() }, { additionalProperties: false });
        const req = { body: { a: 'x', b: 1 } };
        const error = await run(validate(Body), req);
        assert.deepEqual(error.details, [{ field: 'b', message: 'Campo no permitido.' }]);
        assert.deepEqual(req.body, { a: 'x', b: 1 });
    });
});

describe('tokens y codigos', () => {
    it('generateCode siempre da 6 digitos (con ceros a la izquierda)', () => {
        for (let i = 0; i < 500; i += 1) assert.match(generateCode(), /^\d{6}$/);
    });
    it('hashCode depende del proposito, el correo y el codigo', () => {
        const base = hashCode('verify', 'a@b.co', '123456');
        assert.equal(base, hashCode('verify', 'a@b.co', '123456'));
        assert.notEqual(base, hashCode('recovery', 'a@b.co', '123456'));
        assert.notEqual(base, hashCode('verify', 'c@d.co', '123456'));
        assert.notEqual(base, hashCode('verify', 'a@b.co', '654321'));
    });
    it('safeEqual compara sin lanzar con longitudes distintas o vacios', () => {
        assert.equal(safeEqual('abc', 'abc'), true);
        assert.equal(safeEqual('abc', 'abd'), false);
        assert.equal(safeEqual('abc', 'abcd'), false);
        assert.equal(safeEqual(undefined, 'abc'), false);
    });
});

describe('serializeQuestion (lista blanca)', () => {
    it('nunca expone la clave aunque el documento la traiga', async () => {
        const { serializeQuestion } = await import('#Serializers/question.serializer.js');
        const result = serializeQuestion({
            _id: 'q', question: '<p>x</p>', options: { B: 'dos', A: 'uno' },
            rpta: 'A', rpta_text: 'uno', resolution: 'porque', options_answers: { A: 1 }, total_answers: 1,
            created_by: 'secreto', hash: 'abc', verified_by: 'admin',
        });
        const json = JSON.stringify(result);
        for (const leaked of ['rpta', 'resolution', 'options_answers', 'total_answers', 'secreto', 'abc', 'admin']) {
            assert.ok(!json.includes(leaked), `expone ${leaked}`);
        }
        assert.deepEqual(result.options.map((option) => option.key), ['A', 'B']);
    });

    it('acepta options como Map (documento de Mongoose)', async () => {
        const { optionEntries } = await import('#Serializers/question.serializer.js');
        assert.deepEqual(optionEntries(new Map([['B', 'x'], ['A', 'y']])), [['A', 'y'], ['B', 'x']]);
        assert.deepEqual(optionEntries(null), []);
    });
});

describe('absolutizeHtml', () => {
    it('absolutiza src/href relativos y deja intactas las URLs absolutas y data:', async () => {
        const { absolutizeHtml } = await import('#Libs/urls.js');
        const html = '<img src="/images/a.png"><a href="/x">l</a><img src="https://cdn/b.png"><img src="data:image/png;base64,AAA">';
        const result = absolutizeHtml(html);
        assert.match(result, /src="https:\/\/eduteka\.test\/images\/a\.png"/);
        assert.match(result, /href="https:\/\/eduteka\.test\/x"/);
        assert.match(result, /src="https:\/\/cdn\/b\.png"/);
        assert.match(result, /src="data:image\/png;base64,AAA"/);
        assert.equal(absolutizeHtml(null), null);
    });
});

describe('ApiError', () => {
    it('tooManyRequests redondea Retry-After hacia arriba y nunca es menor que 1', () => {
        assert.equal(ApiError.tooManyRequests(0).headers['Retry-After'], '1');
        assert.equal(ApiError.tooManyRequests(12.2).headers['Retry-After'], '13');
    });
});
