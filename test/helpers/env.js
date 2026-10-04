// Variables de entorno base de las pruebas. Se importa ANTES que cualquier modulo
// de src/ porque #Config/settings.js las lee una sola vez al cargarse.
export const BASE_ENV = {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:1/no-se-usa',
    JWT_SECRET: 'test-secret-test-secret-test-secret-1234567890',
    MAIL_PROVIDER: 'memory',
    // Nada escucha en el puerto 1: garantiza el cliente en memoria y que un
    // Redis local del desarrollador no reciba claves `api:` de las pruebas.
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '1',
    REDIS_STARTUP_MAX_RETRIES: '0',
    REDIS_CONNECT_TIMEOUT_MS: '300',
    BCRYPT_ROUNDS: '4',
    CODE_COOLDOWN_SECONDS: '0',
    RATE_LIMIT_GLOBAL: '100000',
    RATE_LIMIT_AUTH: '100000',
    RATE_LIMIT_AUTH_EMAIL: '100000',
    RATE_LIMIT_WRITE: '100000',
    LOGIN_MAX_FAILURES: '5',
    REFRESH_GRACE_SECONDS: '0',
    PUBLIC_WEB_URL: 'https://eduteka.test',
    // Lector de comprobantes en memoria: sin lectura fijada devuelve null (revision manual).
    PAYMENT_AI_PROVIDER: 'memory',
    // Vacias = sin definir (settings trata '' como ausente). Evitan que un .env local de
    // desarrollo se cuele en las pruebas: dotenv no pisa variables ya definidas.
    PUBLIC_API_URL: '',
    GEMINI_API_KEY: '',
    ADMIN_EMAIL: '',
    PAYMENT_YAPE_NUMBER: '',
    PAYMENT_YAPE_HOLDER: '',
    PAYMENT_YAPE_QR_URL: '',
    PAYMENT_PLIN_NUMBER: '',
    PAYMENT_PLIN_HOLDER: '',
    PAYMENT_PLIN_QR_URL: '',
};

Object.assign(process.env, BASE_ENV);
