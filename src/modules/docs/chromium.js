// Un solo Chromium para todos los documentos de este proceso (edk-docs).
//
// El monolito abria un Chromium entero por cada PDF (eduteka/src/libs/generatePdf.js): con varios a
// la vez se agotaba la memoria del droplet. Aqui hay uno, compartido, con una pagina por trabajo;
// la concurrencia la limita el worker de la cola (DOCS_CONCURRENCY).
//
// Se reinicia solo: cada `browserMaxJobs` documentos (Chromium acumula memoria con el uso) o si se
// desconecta (se cayo). Un reinicio espera a que terminen las paginas que estan abiertas.

import puppeteer from 'puppeteer-core';
import { settings } from '#Config/settings.js';
import { logger } from '#Libs/logger.js';

export class ChromiumUnavailableError extends Error {
    constructor(message = 'Chromium no esta configurado (DOCS_CHROMIUM_PATH)') {
        super(message);
        this.name = 'ChromiumUnavailableError';
    }
}

/**
 * Crea un administrador de navegador. `launch` se puede inyectar (pruebas); por defecto lanza el
 * Chromium de `executablePath`.
 */
export const createBrowserManager = ({
    executablePath = settings.docs.chromiumPath,
    noSandbox = settings.docs.chromiumNoSandbox,
    maxJobs = settings.docs.browserMaxJobs,
    launch = (options) => puppeteer.launch(options),
} = {}) => {
    let browser = null;
    let starting = null;
    let used = 0;
    let active = 0;
    let retiring = null; // navegador viejo que se cierra cuando sus paginas terminan

    const start = async () => {
        if (!executablePath) throw new ChromiumUnavailableError();
        const instance = await launch({
            executablePath,
            headless: true,
            args: noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'],
        });
        instance.on('disconnected', () => {
            if (browser === instance) {
                logger.warn('Chromium se desconecto; se lanzara otro en el proximo documento');
                browser = null;
            }
        });
        used = 0;
        return instance;
    };

    const current = async () => {
        if (browser?.connected === false) browser = null;
        if (browser && used >= maxJobs) {
            // Se retira: los documentos en curso terminan en el viejo, los nuevos van a uno nuevo.
            retiring = { instance: browser, pending: active };
            browser = null;
            if (retiring.pending === 0) await retiring.instance.close().catch(() => {});
        }
        if (!browser) {
            starting ??= start().finally(() => { starting = null; });
            browser = await starting;
        }
        return browser;
    };

    /** Ejecuta `fn(page)` en una pagina nueva del navegador compartido y la cierra siempre. */
    const withPage = async (fn) => {
        const instance = await current();
        used += 1;
        active += 1;
        let page;
        try {
            page = await instance.newPage();
            return await fn(page);
        } finally {
            await page?.close().catch(() => {});
            active -= 1;
            if (retiring && retiring.instance === instance) {
                retiring.pending -= 1;
                if (retiring.pending <= 0) {
                    const old = retiring.instance;
                    retiring = null;
                    await old.close().catch(() => {});
                }
            }
        }
    };

    const close = async () => {
        const instances = [browser, retiring?.instance].filter(Boolean);
        browser = null;
        retiring = null;
        await Promise.all(instances.map((instance) => instance.close().catch(() => {})));
    };

    return { withPage, close, stats: () => ({ used, active, running: Boolean(browser) }) };
};
