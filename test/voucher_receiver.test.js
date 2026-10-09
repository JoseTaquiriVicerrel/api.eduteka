import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/env.js';

// Reglas de pago que no dependen de la base: destinatario del comprobante, monto alto y
// minimizacion de metadatos antes de enviar la imagen a la IA.

const { checkReceiver, nameMatches, numberMatches, safeText } = await import('#Modules/payments/voucher.receiver.js');
const { assessVoucher } = await import('#Modules/payments/voucher.verify.js');
const { stripMetadata } = await import('#Modules/payments/voucher.privacy.js');

const DAY = 86_400_000;
const today = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const reading = (extra = {}) => ({ monto: 15, fecha: today(), numero_operacion: '123456', receptor: 'Jose Taquiri', ...extra });
const methods = [{ id: 'yape', holder: 'José Manuel Taquiri Vicerrel', number: '931 988 077' }];

describe('destinatario del comprobante', () => {
    it('reconoce el nombre aunque venga abreviado, sin tildes o en otro orden', () => {
        const holder = 'José Manuel Taquiri Vicerrel';
        for (const read of ['Jose Taquiri', 'JOSE M. TAQUIRI V.', 'Taquiri Vicerrel Jose', 'José Manuel Taquiri Vicerrel', 'Jose T. Vicerrel']) {
            assert.equal(nameMatches(read, holder), true, read);
        }
    });

    it('rechaza otra persona, solo iniciales o un nombre vacio', () => {
        const holder = 'José Manuel Taquiri Vicerrel';
        for (const read of ['Maria Lopez Quispe', 'Pedro Taquiri', 'J. M. T. V.', '', null, 'Jose Mamani']) {
            assert.equal(nameMatches(read, holder), false, String(read));
        }
    });

    it('acepta el nombre completo mas largo que el configurado (razon social)', () => {
        assert.equal(nameMatches('Eduteka', 'Eduteka'), true);
        assert.equal(nameMatches('Eduteka Peru', 'Eduteka'), true);
    });

    it('compara los digitos visibles con el final del numero configurado', () => {
        assert.equal(numberMatches('*** *** 077', '931 988 077'), true);
        assert.equal(numberMatches('931988077', '931 988 077'), true);
        assert.equal(numberMatches('*** 078', '931 988 077'), false);
        assert.equal(numberMatches('77', '931 988 077'), false, 'menos de 3 digitos no basta');
    });

    it('sin titular ni numero configurados no se puede exigir', () => {
        assert.deepEqual(checkReceiver('Cualquiera', []), { applicable: false, matches: true });
        assert.deepEqual(checkReceiver('Cualquiera', [{ id: 'yape', holder: null, number: null }]), { applicable: false, matches: true });
        assert.deepEqual(checkReceiver('Cualquiera', methods), { applicable: true, matches: false });
    });

    it('limpia el texto de la IA antes de ponerlo en el motivo del panel', () => {
        assert.equal(safeText('<script>alert(1)</script> Ana'), 'script alert 1 script Ana');
        assert.equal(safeText('x'.repeat(200)).length, 50);
    });
});

describe('assessVoucher: destinatario y monto alto', () => {
    const assess = (data, expected = 15, options = {}) =>
        assessVoucher(data, expected, { reused: false, methods, requireReceiver: true, autoApproveMax: 0, ...options });

    it('aprueba cuando el destinatario es el titular', async () => {
        assert.deepEqual(await assess(reading()), { approved: true, reason: null });
        assert.equal((await assess(reading({ receptor: '*** *** 077' }))).approved, true);
    });

    it('un comprobante pagado a otra persona queda en revision con el motivo', async () => {
        const result = await assess(reading({ receptor: 'Maria <b>Lopez</b>' }));
        assert.equal(result.approved, false);
        assert.equal(result.reason, 'El destinatario del comprobante (Maria b Lopez b) no coincide con el titular de pago');
    });

    it('si la IA no lee al destinatario, revision manual', async () => {
        assert.equal((await assess(reading({ receptor: null }))).reason, 'No se pudo leer el destinatario del pago');
    });

    it('PAYMENT_REQUIRE_RECEIVER_MATCH=false o sin datos de pago: no se exige', async () => {
        assert.equal((await assess(reading({ receptor: 'Otra Persona' }), 15, { requireReceiver: false })).approved, true);
        assert.equal((await assess(reading({ receptor: 'Otra Persona' }), 15, { methods: [] })).approved, true);
    });

    it('los demas motivos conservan su prioridad sobre el destinatario', async () => {
        assert.equal((await assess(reading({ receptor: 'Otra', monto: 10 }))).reason, 'Monto no coincide: esperado 15.00 vs encontrado 10.00');
        const old = new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10);
        assert.match((await assess(reading({ receptor: 'Otra', fecha: old }))).reason, /más de 3 días/);
    });

    it('un monto por encima del limite nunca se aprueba solo', async () => {
        const big = reading({ monto: 300 });
        assert.equal((await assess(big, 300, { autoApproveMax: 0 })).approved, true, '0 = sin limite');
        assert.equal((await assess(big, 300, { autoApproveMax: 300 })).approved, true, 'igual al limite pasa');
        const held = await assess(big, 300, { autoApproveMax: 200 });
        assert.equal(held.approved, false);
        assert.equal(held.reason, 'Monto alto (S/ 300.00): requiere revisión manual (la aprobación automática llega hasta S/ 200.00)');
    });
});

describe('metadatos del comprobante enviado a la IA', () => {
    const scan = Buffer.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 1, 2, 3, 0xff, 0xd9]);
    const segment = (marker, payload) => {
        const body = Buffer.from(payload);
        const head = Buffer.alloc(4);
        head[0] = 0xff;
        head[1] = marker;
        head.writeUInt16BE(body.length + 2, 2);
        return Buffer.concat([head, body]);
    };
    const jpeg = (...segments) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, scan]);

    it('JPEG: quita EXIF/GPS, IPTC y comentarios y conserva el resto', () => {
        const keep = segment(0xdb, [1, 2, 3, 4]);
        const source = jpeg(
            segment(0xe0, 'JFIF\0'),
            segment(0xe1, 'Exif\0\0GPS-LAT-12.0'),
            segment(0xed, 'IPTC'),
            segment(0xfe, 'telefono-de-ana'),
            keep,
        );
        const result = stripMetadata(source);

        assert.ok(result.length < source.length);
        assert.equal(result.includes('GPS-LAT'), false);
        assert.equal(result.includes('telefono-de-ana'), false);
        assert.equal(result.includes(keep), true, 'la tabla de cuantizacion sigue');
        assert.deepEqual([...result.subarray(0, 2)], [0xff, 0xd8]);
        assert.deepEqual([...result.subarray(-5)], [1, 2, 3, 0xff, 0xd9], 'los datos de imagen quedan intactos');
    });

    const pngChunk = (type, data = Buffer.alloc(0)) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(type, 4, 'latin1');
        return Buffer.concat([head, data, Buffer.alloc(4)]);
    };

    it('PNG: quita texto y EXIF incrustados y conserva IHDR, IDAT e IEND', () => {
        const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const ihdr = pngChunk('IHDR', Buffer.alloc(13));
        const idat = pngChunk('IDAT', Buffer.from([9, 9, 9]));
        const source = Buffer.concat([
            signature, ihdr, pngChunk('tEXt', Buffer.from('Author\0Ana')), pngChunk('eXIf', Buffer.from('GPS')), idat, pngChunk('IEND'),
        ]);
        const result = stripMetadata(source);

        assert.equal(result.includes('Author'), false);
        assert.equal(result.includes('GPS'), false);
        assert.equal(result.includes(ihdr), true);
        assert.equal(result.includes(idat), true);
        assert.equal(result.subarray(-12).toString('latin1', 4, 8), 'IEND');
    });

    it('lo que no es una imagen reconocible, o esta truncado, se devuelve tal cual', () => {
        const junk = Buffer.from('no soy una imagen');
        assert.equal(stripMetadata(junk), junk);
        const truncated = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe1, 'Exif')]).subarray(0, 6);
        assert.equal(stripMetadata(truncated), truncated);
    });
});
