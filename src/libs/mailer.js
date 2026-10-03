import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handlebars from 'handlebars';
import nodemailer from 'nodemailer';
import { settings } from '#Config/settings.js';
import { logger } from '#Libs/logger.js';

// Envio de correo de la API. Sustituye a #Libs/send_mail.js del monolito, que
// importa `resend` (no instalado), lee la plantilla en cada envio y devuelve
// `undefined` (no `false`) cuando el remitente no coincide con ninguna rama.
//
// Proveedores (settings.mail.provider): resend (API HTTP, sin dependencias),
// smtp (nodemailer), console (solo desarrollo) y memory (tests).

const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../views/mail');
const templateCache = new Map();
const SEND_TIMEOUT_MS = 10_000;

const renderTemplate = (name, data) => {
    if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`Nombre de plantilla invalido: ${name}`);
    let compiled = templateCache.get(name);
    if (!compiled) {
        compiled = handlebars.compile(fs.readFileSync(path.join(TEMPLATES_DIR, `${name}.hbs`), 'utf-8'));
        templateCache.set(name, compiled);
    }
    return compiled(data);
};

let smtpTransport;
const getSmtpTransport = () => {
    smtpTransport ??= nodemailer.createTransport({
        host: settings.mail.smtp.host,
        port: settings.mail.smtp.port,
        secure: settings.mail.smtp.secure,
        auth: settings.mail.smtp.user ? { user: settings.mail.smtp.user, pass: settings.mail.smtp.pass } : undefined,
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
    });
    return smtpTransport;
};

const sendWithResend = async ({ to, subject, html }) => {
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${settings.mail.resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: settings.mail.from, to, subject, html }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
        // El cuerpo de error de Resend no lleva secretos; se registra para diagnosticar.
        throw new Error(`Resend respondio ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
};

/** Bandeja en memoria del proveedor `memory` (tests). */
export const outbox = [];

/**
 * Renderiza la plantilla y envia. Devuelve true/false y nunca lanza: quien llama
 * decide que hacer si el correo no salio.
 *
 * `data.code` viaja solo a la plantilla; el log no lo incluye (salvo el
 * proveedor `console`, que existe justamente para verlo en desarrollo).
 */
export const sendMail = async ({ to, subject, template, data = {} }) => {
    try {
        const html = renderTemplate(template, data);

        switch (settings.mail.provider) {
            case 'memory':
                outbox.push({ to, subject, template, data, html });
                break;
            case 'console':
                logger.info({ to, subject, template, data }, 'Correo (proveedor console)');
                break;
            case 'resend':
                await sendWithResend({ to, subject, html });
                break;
            case 'smtp':
                await getSmtpTransport().sendMail({ from: settings.mail.from, to, subject, html });
                break;
            default:
                throw new Error(`Proveedor de correo desconocido: ${settings.mail.provider}`);
        }
        return true;
    } catch (error) {
        logger.error({ err: error.message, template, provider: settings.mail.provider }, 'No se pudo enviar el correo');
        return false;
    }
};

export default sendMail;
