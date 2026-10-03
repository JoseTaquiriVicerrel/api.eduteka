import { BASE_ENV } from './env.js';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Arranca la API contra una MongoDB en memoria, sin tocar ninguna base real.
//
// Cada archivo de test corre en su propio proceso (node --test), asi que cada
// uno levanta su mongod y su propia configuracion. Las variables de entorno se
// fijan ANTES de importar cualquier modulo de src/, porque #Config/settings.js
// las lee una sola vez al cargarse.

export async function bootTestApp(envOverrides = {}) {
    Object.assign(process.env, BASE_ENV, envOverrides);

    const mongod = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongod.getUri();

    const { default: mongoose } = await import('mongoose');
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    await mongoose.connect(process.env.MONGODB_URI);

    const [{ createApp }, { default: User }, { default: RefreshToken }, mailer, kv] = await Promise.all([
        import('../../src/app.js'),
        import('#Models/user_model.js'),
        import('#Models/refresh_token_model.js'),
        import('#Libs/mailer.js'),
        import('#Libs/kv.js'),
    ]);

    // Igual que produccion: users.email tiene su indice unico (lo crea el monolito).
    await User.collection.createIndex({ email: 1 }, { unique: true, name: 'email_1' });
    // refreshtokens es de la API y crea sus propios indices al arrancar.
    await RefreshToken.init();

    return {
        app: createApp(),
        mongoose,
        User,
        RefreshToken,
        outbox: mailer.outbox,
        kv,
        async stop() {
            await mongoose.disconnect();
            await mongod.stop();
        },
    };
}

/** Ultimo codigo enviado a `email` con la plantilla dada. */
export function lastCode(outbox, email, template) {
    const mails = outbox.filter((mail) => mail.to === email && (!template || mail.template === template));
    return mails.at(-1)?.data.code;
}

/** Deja correr los envios que la API no espera (`void sendMail(...)`). */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Espera a que `read()` devuelva algo (escrituras sin await, como la bitacora). */
export const eventually = async (read, { tries = 50, delayMs = 20 } = {}) => {
    for (let i = 0; i < tries; i += 1) {
        const value = await read();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
};
