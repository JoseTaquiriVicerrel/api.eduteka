import path from 'node:path';
import '#Config/env.js';

// Configuracion de la API validada al arrancar. `env.js` solo carga el .env (lo
// comparte el punto de entrada antiguo); aqui se lee, se convierte a su tipo y se
// rechaza el arranque si falta algo, en vez de descubrirlo en la primera peticion.

const env = process.env;
const problems = [];

const str = (name, fallback) => {
    const value = env[name];
    return value === undefined || value.trim() === '' ? fallback : value.trim();
};

const required = (name, { minLength = 1 } = {}) => {
    const value = str(name);
    if (value === undefined) {
        problems.push(`${name} es obligatoria`);
        return '';
    }
    if (value.length < minLength) {
        problems.push(`${name} debe tener al menos ${minLength} caracteres`);
    }
    return value;
};

const int = (name, fallback, { min = -Infinity, max = Infinity } = {}) => {
    const raw = str(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        problems.push(`${name} debe ser un entero entre ${min} y ${max}`);
        return fallback;
    }
    return value;
};

const bool = (name, fallback) => {
    const raw = str(name);
    if (raw === undefined) return fallback;
    if (['true', '1', 'yes', 'si'].includes(raw.toLowerCase())) return true;
    if (['false', '0', 'no'].includes(raw.toLowerCase())) return false;
    problems.push(`${name} debe ser true o false`);
    return fallback;
};

const semver = (name, fallback) => {
    const value = str(name, fallback);
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
        problems.push(`${name} debe tener el formato x.y.z`);
        return fallback;
    }
    return value;
};

const list = (name) => (str(name, '') ?? '').split(',').map((item) => item.trim()).filter(Boolean);

const parseTrustProxy = () => {
    const raw = str('TRUST_PROXY', 'false');
    if (raw === 'false') return false;
    if (raw === 'true') return true;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw; // lista de subredes que acepta Express ("loopback, 10.0.0.0/8")
};

// El WEB_URL/APP_URL del monolito suele venir sin esquema ("www.eduteka.site");
// un cliente que lo use como enlace o para armar la URL de un avatar necesita
// una URL absoluta.
const normalizeWebUrl = (value) => {
    if (!value) return null;
    const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return withScheme.replace(/\/+$/, '');
};

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production' || env.MODE === 'PRODUCTION';
const isTest = nodeEnv === 'test';

// --- Correo -----------------------------------------------------------------
// resend -> API HTTP de Resend | smtp -> nodemailer | console -> imprime el
// mensaje en el log (solo desarrollo) | memory -> lo guarda en memoria (tests).
const smtpHost = str('SMTP_HOST', str('EMAIL_SMTP'));
const resendKey = str('RESEND_API_KEY');
const mailProvider = str('MAIL_PROVIDER', resendKey ? 'resend' : smtpHost ? 'smtp' : isProduction ? undefined : 'console');

if (!['resend', 'smtp', 'console', 'memory'].includes(mailProvider)) {
    problems.push('No hay proveedor de correo: define RESEND_API_KEY o SMTP_HOST (o MAIL_PROVIDER)');
}
if (mailProvider === 'resend' && !resendKey) problems.push('MAIL_PROVIDER=resend requiere RESEND_API_KEY');
if (mailProvider === 'smtp' && !smtpHost) problems.push('MAIL_PROVIDER=smtp requiere SMTP_HOST');
if (isProduction && ['console', 'memory'].includes(mailProvider)) {
    problems.push(`MAIL_PROVIDER=${mailProvider} no se permite en produccion`);
}

const smtpPort = int('SMTP_PORT', int('EMAIL_PORT', 465, { min: 1, max: 65535 }), { min: 1, max: 65535 });

const jwtSecret = required('JWT_SECRET', { minLength: 32 });

const settings = Object.freeze({
    nodeEnv,
    isProduction,
    isTest,
    port: int('PORT', 3000, { min: 1, max: 65535 }),
    mongoUri: required('MONGODB_URI'),
    trustProxy: parseTrustProxy(),
    logLevel: str('LOG_LEVEL', isTest ? 'silent' : 'info'),
    prettyLogs: nodeEnv === 'development',
    corsOrigins: list('API_CORS_ORIGINS'),

    jwt: Object.freeze({
        secret: jwtSecret,
        // Secreto propio del flujo de recuperacion. El claim `typ` ya impide
        // reutilizar un token en otro flujo; el secreto aparte es una barrera mas.
        resetSecret: str('JWT_RESET_SECRET', jwtSecret),
        issuer: 'eduteka-api',
        accessTtlSeconds: int('ACCESS_TTL_SECONDS', 1800, { min: 60, max: 86400 }),
        refreshTtlDays: int('REFRESH_TTL_DAYS', 60, { min: 1, max: 365 }),
        resetTtlSeconds: int('RESET_TTL_SECONDS', 900, { min: 60, max: 3600 }),
        // Tras rotar un refresh token, el anterior sigue valiendo este tiempo para
        // el mismo dueño. Cuando varias peticiones reciben 401 a la vez y todas
        // intentan refrescar, la primera rota y las demas parecerian un robo; sin
        // gracia se cerraria la sesion del usuario. 0 la desactiva.
        refreshGraceSeconds: int('REFRESH_GRACE_SECONDS', 30, { min: 0, max: 300 }),
    }),

    auth: Object.freeze({
        bcryptRounds: int('BCRYPT_ROUNDS', 10, { min: isTest ? 4 : 10, max: 15 }),
        verifyCodeTtlMinutes: int('VERIFY_CODE_TTL_MINUTES', 15, { min: 1, max: 120 }),
        recoveryCodeTtlMinutes: int('RECOVERY_CODE_TTL_MINUTES', 10, { min: 1, max: 120 }),
        codeMaxAttempts: int('CODE_MAX_ATTEMPTS', 5, { min: 1, max: 20 }),
        codeCooldownSeconds: int('CODE_COOLDOWN_SECONDS', 60, { min: 0, max: 3600 }),
        loginMaxFailures: int('LOGIN_MAX_FAILURES', 5, { min: 1, max: 100 }),
        loginFailureWindowSeconds: int('LOGIN_FAILURE_WINDOW_SECONDS', 900, { min: 60, max: 86400 }),
    }),

    // Archivos propios de la API (avatares). Nunca dentro de la raiz estatica de ningun sitio.
    storageDir: path.resolve(str('STORAGE_DIR', './storage')),
    // Comprobantes de pago de simulacros. Para que el panel del monolito los vea hay que
    // apuntarlo a su carpeta (src/public/protected/pay_capture); por defecto, dentro de STORAGE_DIR.
    payCaptureDir: path.resolve(str('PAY_CAPTURE_DIR', path.join(str('STORAGE_DIR', './storage'), 'pay_capture'))),
    // Raiz contra la que se resuelven las rutas de archivos guardadas en la base (`files[].path`,
    // por ejemplo "storage/examenes/x.pdf"). En el monolito es su carpeta `src`; por defecto, la
    // carpeta que contiene a STORAGE_DIR.
    filesRootDir: path.resolve(str('FILES_ROOT_DIR', path.join(str('STORAGE_DIR', './storage'), '..'))),
    // Aviso interno cuando llega un comprobante por verificar.
    adminEmail: str('ADMIN_EMAIL', null),

    limits: Object.freeze({
        // Respuestas nuevas por dia (hora de Lima) para cuentas sin suscripcion
        // activa. 0 = sin limite. Cambiar de opcion en una pregunta ya respondida no cuenta.
        freeDailyAnswers: int('FREE_DAILY_ANSWER_LIMIT', 0, { min: 0 }),
        // Preguntas que ve de un examen quien no tiene suscripcion vigente (vista previa).
        // 0 = el examen completo, como en la web hoy.
        examPreviewQuestions: int('EXAM_PREVIEW_QUESTIONS', 0, { min: 0 }),
        // La web da el solucionario de un simulacro a quien lo rindio, sin suscripcion (solo
        // los docentes la necesitan). true = exigirla tambien a los estudiantes (especificacion).
        solucionarioRequiresPlan: bool('SOLUCIONARIO_REQUIRES_PLAN', false),
        // Holgura para guardar la ultima respuesta: la app corta en end_exam con la hora del
        // servidor, pero la peticion tarda en llegar.
        simulacrumAnswerGraceSeconds: int('SIMULACRUM_ANSWER_GRACE_SECONDS', 5, { min: 0, max: 60 }),
    }),

    rateLimit: Object.freeze({
        global: int('RATE_LIMIT_GLOBAL', 120, { min: 1 }),
        auth: int('RATE_LIMIT_AUTH', 10, { min: 1 }),
        authEmail: int('RATE_LIMIT_AUTH_EMAIL', 5, { min: 1 }),
        write: int('RATE_LIMIT_WRITE', 60, { min: 1 }),
    }),

    app: Object.freeze({
        minVersion: semver('APP_MIN_VERSION', '1.0.0'),
        latestVersion: semver('APP_LATEST_VERSION', '1.0.0'),
        paymentsEnabled: bool('APP_PAYMENTS_ENABLED', true),
        maintenance: bool('APP_MAINTENANCE', false),
        supportWhatsapp: str('SUPPORT_WHATSAPP', null),
        webUrl: normalizeWebUrl(str('PUBLIC_WEB_URL', str('WEB_URL', str('APP_URL', null)))),
        // URL publica de ESTA API (para los enlaces absolutos a archivos que sirve, como los avatares).
        apiUrl: normalizeWebUrl(str('PUBLIC_API_URL', null)),
    }),

    mail: Object.freeze({
        provider: mailProvider,
        from: str('MAIL_FROM', 'Eduteka <no-reply@eduteka.site>'),
        resendApiKey: resendKey,
        smtp: Object.freeze({
            host: smtpHost,
            port: smtpPort,
            secure: bool('SMTP_SECURE', smtpPort === 465),
            user: str('SMTP_USER', str('EMAIL')),
            pass: str('SMTP_PASSWORD', str('EMAIL_PASSWORD')),
        }),
    }),
});

if (problems.length > 0) {
    throw new Error(`Configuracion invalida:\n - ${problems.join('\n - ')}`);
}

export { settings };
export default settings;
