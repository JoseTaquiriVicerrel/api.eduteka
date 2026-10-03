import UserModel from '#Models/user_model.js';
import OrderModel from '#Models/order_model.js';
import bcrypt from 'bcrypt';
import { jwtVerify } from 'jose';
import { renderSessionExpired, renderForbidden, renderSubscriptionRequired } from '#Libs/render_error.js';
import { renewSessionIfExpiring } from '#Libs/session.js';

// Proyeccion unica del usuario de sesion. La comparten la sesion por cookie del
// SSR (check_session) y el middleware Bearer de /api/v1, para que ambos vean
// exactamente los mismos campos y no haya que mantener dos listas en paralelo.
const SESSION_USER_FIELDS = {
  _id:true,
  rol:true,
  suscription:true,
  account_type:true,
  departament:true,
  university: true,
  avatar: true,
  username:true,
  email:true,
  dni:true,
  isVerified:true,
  fullname:true,
  notification:true,
  beta_teacher_blocked:true,
};

// Usuario anonimo. Se devuelve una copia en cada llamada para que un consumidor
// que mute el objeto (p.ej. al escribirlo en res.locals) no contamine al resto.
const anonymousSession = () => ({ anonymous: true, rol: "User" });

// Verifica la firma HS256 de un JWT emitido por la plataforma. Lanza si el token
// es invalido o expiro: quien llama decide si eso es un 401 (API) o una sesion
// anonima (SSR).
const verifyJwt = async (token) => {
  const encoder = new TextEncoder();
  return jwtVerify(token, encoder.encode(process.env.JWT_PRIVATE_KEY));
};

// Carga el usuario de sesion por id. Devuelve null si la cuenta ya no existe
// (token valido emitido antes de eliminar al usuario).
const loadSessionUser = async (uid) => {
  return UserModel.findById(uid, SESSION_USER_FIELDS).lean().exec();
};

/**
 * Resuelve la sesion de la cookie.
 *
 * Con `res`, ademas renueva la cookie cuando al token le queda poco
 * (#Libs/session.js): renovacion deslizante, para que a quien esta usando la
 * plataforma no se le caiga la sesion a mitad de un examen solo porque hayan
 * pasado 5 dias desde que entro. Sin `res` (la app movil, los tests) se limita
 * a leer.
 *
 * El campo `session_expires_at` (ms epoch) viaja hasta la vista para que el
 * aviso previo del cliente (#Public/js/session_guard.js) sepa cuando avisar.
 */
const check_session = async (req, res = null) => {

  const sessionCokie = req.cookies.session || "";

  if (sessionCokie === "") {
    return anonymousSession();
  }

  try {
    const { payload } = await verifyJwt(sessionCokie);
    const user = await loadSessionUser(payload.uid);

    // Token valido pero la cuenta ya no existe (usuario eliminado con cookie vigente).
    if (!user) {
      return anonymousSession();
    }

    const expiresAt = res
      ? await renewSessionIfExpiring(res, payload.uid, payload.exp)
      : Number(payload.exp) * 1000;

    return { ...user, session_expires_at: expiresAt };
  } catch (err) {
    return anonymousSession();
  }

}

const cryptPassword = (password, callback) => {
  bcrypt.genSalt(10, function (err, salt) {
    if (err)
      return callback(err);
    bcrypt.hash(password, salt, function (err, hash) {
      return callback(err, hash);
    });
  });
};

const comparePassword = (plainPass, hashword, callback) => {
  bcrypt.compare(plainPass, hashword, function (err, isPasswordMatch) {
    return err == null ?
      callback(null, isPasswordMatch) :
      callback(err);
  });
};
// El middleware global de src/config/express.js ya resuelve la cookie de sesion
// via check_session() y deja el usuario en res.locals.user_session en cada
// peticion, antes de que se monten los routers. authorize() reutiliza ese
// resultado en vez de volver a verificar el JWT y consultar la BD de nuevo.
function authorize(role, sucription = false) {
  return function (req, res, next) {
    const user = res.locals.user_session;

    // Sesion caducada o ausente. Antes esto era un 404 (o, para las peticiones
    // de fondo, un `{error:'Not Authorized'}` con estado 200 que ningun callback
    // sabia leer y que hacia fallar la accion en silencio). Ahora navegando se
    // redirige a /login con el destino de vuelta, y de fondo sale un 401 que
    // callFetchEdk reconoce.
    if (!user || user.anonymous) {
      return renderSessionExpired(req, res);
    }

    if (user.rol === "Administrador") {
      return next();
    }

    // Se acepta tanto el rol ("Administrador", "User") como el tipo de cuenta
    // ("Estudiante", "Profesor"). Son dos campos distintos del usuario y sus
    // valores no se solapan, asi que admitir ambos no ensancha ninguna regla
    // existente: authorize("Profesor") no puede casar contra un rol, ni
    // authorize("Administrador") contra un account_type.
    //
    // Hace falta porque un profesor es `rol: "User"` + `account_type:
    // "Profesor"`: sin esto, authorize("Profesor") no dejaria pasar a nadie.
    const allowedRoles = Array.isArray(role) ? role : [role];
    const identities = [user.rol, user.account_type];
    if (!allowedRoles.some((allowed) => identities.includes(allowed)) && role !== "Auth") {
      return renderForbidden(req, res);
    }

    if (sucription && user.suscription?.status !== "activo") {
      return renderSubscriptionRequired(req, res);
    }

    return next();
  }
}


export {
  check_session,
  cryptPassword,
  comparePassword,
  authorize,
  verifyJwt,
  loadSessionUser,
  anonymousSession,
  SESSION_USER_FIELDS,
};
