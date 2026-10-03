/**
 * Emision, renovacion y caducidad de la cookie de sesion (`session`).
 *
 * Antes cada sitio que iniciaba sesion firmaba su propio JWT y montaba sus
 * propias opciones de cookie a mano, y las dos copias no coincidian: el login
 * normal emitia un token de 5 dias, y el camino de registro/verificacion uno de
 * 24 horas metido en una cookie de 5 dias, ademas sin `secure` ni `sameSite`.
 *
 * El desfase no fallaba de forma visible: pasadas las 24 h el navegador seguia
 * mandando una cookie que ya no verificaba, `check_session` devolvia sesion
 * anonima y el usuario quedaba deslogueado sin aviso durante los cuatro dias
 * restantes. Con la emision centralizada aqui, token y cookie caducan juntos
 * por construccion.
 */
import { SignJWT } from 'jose';

export const SESSION_COOKIE_NAME = 'session';

/** Vida del token y de la cookie. Una sola fuente para los dos. */
export const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 5);

/**
 * Margen en el que una sesion viva se reemite sola (ver `renewSessionIfExpiring`).
 * Con 24 h, a quien entra a diario no se le cae nunca la sesion; quien no
 * aparece en 5 dias vuelve a autenticarse.
 */
export const SESSION_RENEW_WINDOW_SECONDS = Number(
  process.env.SESSION_RENEW_WINDOW_SECONDS ?? 60 * 60 * 24
);

/**
 * Opciones de la cookie. `sameSite: 'strict'` es el valor que ya usaba el login
 * normal y se mantiene; si algun dia molesta que al llegar desde un enlace
 * externo (WhatsApp, Google) la primera pagina se pinte como anonima, el cambio
 * es poner 'lax' AQUI y en ningun otro sitio.
 */
const cookieOptions = () => ({
  maxAge: SESSION_TTL_SECONDS * 1000,
  httpOnly: true,
  secure: process.env.MODE === 'PRODUCTION',
  sameSite: 'strict',
  path: '/',
});

const signSessionToken = async (uid) => {
  const encoder = new TextEncoder();
  return new SignJWT({ uid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(encoder.encode(process.env.JWT_PRIVATE_KEY));
};

/**
 * Firma un JWT nuevo y lo deja en la cookie. Unico punto de la app que abre
 * sesion: login, registro, verificacion de codigo y renovacion.
 *
 * @returns {Promise<{ token: string, expires_at: number }>} `expires_at` en ms epoch.
 */
export const issueSessionCookie = async (res, uid) => {
  const token = await signSessionToken(String(uid));
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
  return { token, expires_at: Date.now() + SESSION_TTL_SECONDS * 1000 };
};

/**
 * Borra la cookie con las MISMAS opciones con las que se emitio. `clearCookie`
 * compara path (y domain); con un path distinto el navegador se queda con la
 * cookie vieja y el logout no cierra nada.
 */
export const clearSessionCookie = (res) => {
  const { maxAge, ...attributes } = cookieOptions();
  res.clearCookie(SESSION_COOKIE_NAME, attributes);
};

/**
 * Renovacion deslizante. Si al token le queda menos que la ventana, se reemite
 * en la misma respuesta: quien usa la plataforma no ve caer la sesion a mitad
 * de un examen solo porque hayan pasado 5 dias desde que entro.
 *
 * Silencioso a proposito: si la reemision falla, la peticion sigue con el token
 * actual, que todavia es valido.
 *
 * @param {number} expSeconds `exp` del JWT verificado (segundos epoch).
 * @returns {Promise<number>} ms epoch en que caduca la sesion tras esta peticion.
 */
export const renewSessionIfExpiring = async (res, uid, expSeconds) => {
  const expiresAt = Number(expSeconds) * 1000;
  const remaining = expiresAt - Date.now();

  if (remaining > SESSION_RENEW_WINDOW_SECONDS * 1000) return expiresAt;

  try {
    const { expires_at } = await issueSessionCookie(res, uid);
    return expires_at;
  } catch (err) {
    console.error('No se pudo renovar la cookie de sesion:', err?.message ?? err);
    return expiresAt;
  }
};

/**
 * Valida el `?next=` con el que se vuelve al punto de partida tras reautenticarse.
 *
 * Solo se acepta una ruta interna. Se rechaza todo lo que pueda sacar al usuario
 * del dominio (`//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:`) y
 * las propias rutas de autenticacion, que dejarian al usuario dando vueltas
 * entre /login y /login.
 *
 * @returns {string|null} la ruta, o null si no sirve.
 */
export const safeNextPath = (candidate) => {
  if (typeof candidate !== 'string') return null;

  const value = candidate.trim();
  if (value === '' || value.length > 512) return null;
  if (!value.startsWith('/')) return null;
  // `//host` y `/\host` los resuelve el navegador como otro dominio.
  // charCode 47 = '/', 92 = barra invertida.
  const second = value.charCodeAt(1);
  if (second === 47 || second === 92) return null;
  // Un salto de linea permitiria inyectar cabeceras en el Location.
  if (/[\r\n]/.test(value)) return null;

  const pathname = value.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  const blocked = ['/login', '/logout', '/registrarme', '/recuperar-cuenta', '/verificar-codigo'];
  if (blocked.includes(pathname)) return null;

  return value;
};
