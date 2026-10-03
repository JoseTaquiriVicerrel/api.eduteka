/**
 * Render de las paginas de error del SSR.
 *
 * `error/404.hbs` es un documento completo (<!DOCTYPE html> ... </html>), asi que
 * SIEMPRE tiene que renderizarse sin layout. Cuando cada controlador lo llamaba a
 * mano, 8 de los 85 sitios se olvidaban de `layout: false` y servian el documento
 * anidado dentro del layout principal: HTML invalido, cabecera y footer
 * duplicados, y el <title> del layout pisando al de la pagina de error.
 *
 * Pasando por aqui el layout y el codigo de estado dejan de depender de que cada
 * call site se acuerde.
 *
 * Los tres casos de autenticacion (sesion caducada, sin permiso, sin
 * suscripcion) viven mas abajo. Antes los tres respondian 404 —dos de ellos con
 * texto plano, "Forbidden-Auth" y "Forbidden-Suscripcion"— y el usuario no tenia
 * forma de distinguir "se me cayo la sesion" de "esta pagina no existe".
 */
import { safeNextPath } from '#Libs/session.js';

/**
 * ¿Quien pregunta es una peticion de fondo (fetch/XHR) o una navegacion del
 * navegador? De eso depende si se responde JSON o se manda al usuario a /login.
 *
 * Tres senales, de la mas explicita a la mas general:
 *   1. `X-Requested-With`, que pone el helper `callFetchEdk` (#Public/js/misc.js);
 *   2. un `Accept` que pide JSON y no HTML;
 *   3. `Sec-Fetch-Mode`, que el navegador pone en 'navigate' solo cuando es una
 *      navegacion de verdad. Cubre el `fetch()` suelto que no manda cabeceras.
 */
export const wantsJson = (req) => {
    if (req.xhr) return true;
    if (req.get('X-Requested-With')) return true;

    const accept = req.get('Accept') || '';
    if (accept.includes('application/json') && !accept.includes('text/html')) return true;

    const fetchMode = req.get('Sec-Fetch-Mode');
    if (fetchMode && fetchMode !== 'navigate') return true;

    return false;
};

/**
 * Destino de vuelta tras reautenticarse: la URL que el usuario intentaba abrir.
 * Solo tiene sentido para una navegacion GET; en un POST el cuerpo se pierde de
 * todos modos, y en una peticion de fondo quien decide es el cliente.
 */
const loginUrlFor = (req) => {
    const next = req.method === 'GET' ? safeNextPath(req.originalUrl) : null;
    const params = new URLSearchParams({ reason: 'expired' });
    if (next) params.set('next', next);
    return `/login?${params.toString()}`;
};

/**
 * @param {import('express').Response} res
 * @param {object} [options] datos para la plantilla: `message`, `error_type`.
 */
export const renderNotFound = (res, options = {}) =>
    res.status(404).render('error/404.hbs', { layout: false, ...options });

/**
 * Peticion malformada: filtros de busqueda que no pueden venir de un formulario
 * del sitio (ver #Middlewares/search_filters.js). Reutiliza la plantilla de 404
 * -- que no consulta la base -- pero con el estado que le corresponde, para no
 * darle a un rastreador un 404 que insinue que la URL podria existir con otros
 * parametros.
 *
 * @param {import('express').Response} res
 * @param {object} [options] datos para la plantilla: `message`, `error_type`.
 */
export const renderBadRequest = (res, options = {}) =>
    res.status(400).render('error/404.hbs', {
        layout: false,
        error_type: 'busqueda',
        error_title: 'Búsqueda no válida',
        ...options,
    });

/**
 * Sesion caducada o ausente.
 *
 * Navegando: 302 a /login con el destino de vuelta, que es lo que el usuario
 * espera. De fondo: 401 con `code`, para que `callFetchEdk` lo reconozca y
 * ofrezca volver a entrar sin recargar la pagina a ciegas.
 */
export const renderSessionExpired = (req, res) => {
    const redirect = loginUrlFor(req);

    if (wantsJson(req)) {
        return res.status(401).json({
            status: false,
            code: 'SESSION_EXPIRED',
            message: 'Tu sesión expiró. Vuelve a iniciar sesión para continuar.',
            redirect,
        });
    }

    return res.redirect(redirect);
};

/**
 * Autenticado, pero sin permiso para esta seccion. No es un 404: la pagina
 * existe y el usuario tiene con quien reclamar.
 */
export const renderForbidden = (req, res, options = {}) => {
    if (wantsJson(req)) {
        return res.status(403).json({
            status: false,
            code: 'FORBIDDEN',
            message: options.message ?? 'No tienes acceso a esta sección.',
        });
    }

    return res.status(403).render('error/403.hbs', {
        layout: false,
        error_type: 'permisos',
        error_title: 'Sin acceso',
        ...options,
    });
};

/**
 * Autenticado y con el rol correcto, pero sin suscripcion activa. Se separa de
 * `renderForbidden` a proposito: aqui hay una accion que el usuario SI puede
 * tomar, y servirle un 404 era perder la venta.
 */
export const renderSubscriptionRequired = (req, res, options = {}) => {
    if (wantsJson(req)) {
        return res.status(403).json({
            status: false,
            code: 'SUBSCRIPTION_REQUIRED',
            message: options.message ?? 'Necesitas una suscripción activa para continuar.',
            redirect: '/suscripciones',
        });
    }

    return res.status(403).render('error/403.hbs', {
        layout: false,
        error_type: 'suscripcion',
        error_title: 'Suscripción requerida',
        ...options,
    });
};
