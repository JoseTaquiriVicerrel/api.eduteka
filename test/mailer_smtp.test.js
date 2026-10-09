import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import './helpers/env.js';

// Camino SMTP de mailer.js (nodemailer) contra un servidor SMTP falso en memoria: comprueba que
// el transporte se crea con la configuracion real y que el mensaje llega con remitente,
// destinatario, asunto y HTML. Las demas pruebas usan el proveedor `memory` y no lo cubren.

const received = [];

const startFakeSmtp = () => new Promise((resolve) => {
    const server = net.createServer((socket) => {
        let data = false;
        let buffer = '';
        let mail = { from: null, to: [], body: '' };
        const reply = (line) => socket.write(`${line}\r\n`);

        reply('220 fake ESMTP');
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            if (data) {
                if (!buffer.includes('\r\n.\r\n')) return;
                mail.body = buffer.slice(0, buffer.indexOf('\r\n.\r\n'));
                received.push(mail);
                mail = { from: null, to: [], body: '' };
                buffer = '';
                data = false;
                reply('250 queued');
                return;
            }
            const lines = buffer.split('\r\n');
            buffer = lines.pop();
            for (const line of lines) {
                const upper = line.toUpperCase();
                if (upper.startsWith('EHLO')) { socket.write('250-fake\r\n250 8BITMIME\r\n'); }
                else if (upper.startsWith('HELO')) reply('250 fake');
                else if (upper.startsWith('MAIL FROM')) { mail.from = line.slice(10); reply('250 ok'); }
                else if (upper.startsWith('RCPT TO')) { mail.to.push(line.slice(8)); reply('250 ok'); }
                else if (upper === 'DATA') { data = true; reply('354 go'); }
                else if (upper === 'QUIT') { reply('221 bye'); socket.end(); }
                else reply('250 ok');
            }
        });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
});

describe('mailer: proveedor smtp (nodemailer)', () => {
    let server;
    let sendMail;

    before(async () => {
        server = await startFakeSmtp();
        Object.assign(process.env, {
            MAIL_PROVIDER: 'smtp',
            SMTP_HOST: '127.0.0.1',
            SMTP_PORT: String(server.address().port),
            SMTP_SECURE: 'false',
            SMTP_USER: '',
            SMTP_PASSWORD: '',
            MAIL_FROM: 'Eduteka <no-reply@eduteka.test>',
        });
        ({ sendMail } = await import('#Libs/mailer.js'));
    });
    after(() => new Promise((resolve) => server.close(resolve)));

    it('entrega el correo con remitente, destinatario, asunto y el codigo en el HTML', async () => {
        const sent = await sendMail({
            to: 'ana@example.com',
            subject: 'Tu código de verificación de Eduteka',
            template: 'api_verification_code',
            data: { username: 'Ana', code: '482913', minutes: 15 },
        });

        assert.equal(sent, true);
        assert.equal(received.length, 1);
        const [mail] = received;
        assert.match(mail.from, /no-reply@eduteka\.test/);
        assert.match(mail.to[0], /ana@example\.com/);
        assert.match(mail.body, /Subject: =\?UTF-8\?|Subject: Tu c/);
        assert.match(mail.body, /482913/);
    });

    it('si el servidor no responde, devuelve false y no lanza', async () => {
        await new Promise((resolve) => server.close(resolve));
        const sent = await sendMail({
            to: 'ana@example.com', subject: 'x', template: 'api_verification_code', data: { username: 'Ana', code: '111111', minutes: 15 },
        });
        assert.equal(sent, false);
    });
});
