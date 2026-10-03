import { renderForbidden } from '#Libs/render_error.js';

/**
 * Matriz de capacidades Estudiante / Profesor.
 *
 * `authorize()` (#Libs/auth.js) responde "quien eres"; esto responde "que puedes
 * hacer aqui". Se separa porque la diferencia entre los dos tipos de cuenta no
 * es de acceso a una seccion sino de accion dentro de la misma pagina: los dos
 * ven la pregunta, solo el estudiante la responde.
 *
 * El estudiante practica y genera progreso; el profesor construye material y
 * por eso no responde, no rinde simulacros ni acumula progreso: ve las
 * respuestas directamente.
 *
 * Un usuario anonimo cuenta como Estudiante: hoy puede responder preguntas
 * (se guarda en la sesion) y eso no se toca. Las rutas que exigen cuenta siguen
 * llevando `authorize("Auth")` delante; este modulo no resuelve el login.
 */
export const CAPABILITIES = Object.freeze({
    ANSWER_QUESTIONS: 'answer_questions',
    TAKE_PRACTICE: 'take_practice',
    TAKE_SIMULACRUM: 'take_simulacrum',
    TRACK_PROGRESS: 'track_progress',
    CREATE_PRACTICE: 'create_practice',
    VIEW_ANSWERS_DIRECTLY: 'view_answers_directly',
});

const C = CAPABILITIES;

export const ROLE_CAPABILITIES = Object.freeze({
    Estudiante: Object.freeze([C.ANSWER_QUESTIONS, C.TAKE_PRACTICE, C.TAKE_SIMULACRUM, C.TRACK_PROGRESS]),
    Profesor: Object.freeze([C.CREATE_PRACTICE, C.VIEW_ANSWERS_DIRECTLY]),
});

const isAdmin = (user) => user?.rol === 'Administrador';

export const isTeacher = (user) => !isAdmin(user) && user?.account_type === 'Profesor';

/**
 * El administrador puede todo, igual que en `authorize()`. Cualquier cuenta sin
 * `account_type` valido (anonimos, cuentas antiguas) se trata como Estudiante.
 */
export const can = (user, capability) => {
    if (isAdmin(user)) return capability !== C.VIEW_ANSWERS_DIRECTLY;
    const type = isTeacher(user) ? 'Profesor' : 'Estudiante';
    return ROLE_CAPABILITIES[type].includes(capability);
};

/** Flags para las vistas (`res.locals.can`). */
export const capabilityFlags = (user) => ({
    answer: can(user, C.ANSWER_QUESTIONS),
    take_practice: can(user, C.TAKE_PRACTICE),
    take_simulacrum: can(user, C.TAKE_SIMULACRUM),
    track_progress: can(user, C.TRACK_PROGRESS),
    create_practice: can(user, C.CREATE_PRACTICE),
});

const DENIED_MESSAGES = {
    [C.ANSWER_QUESTIONS]: 'Las cuentas de docente no responden preguntas: ven la respuesta directamente.',
    [C.TAKE_PRACTICE]: 'Las cuentas de docente no resuelven prácticas: ven la práctica con sus respuestas.',
    [C.TAKE_SIMULACRUM]: 'Los simulacros son solo para estudiantes.',
    [C.TRACK_PROGRESS]: 'El progreso es solo para cuentas de estudiante.',
    [C.CREATE_PRACTICE]: 'Crear prácticas es una herramienta para docentes.',
};

/**
 * Middleware. Con `redirect`, una navegacion sin permiso se manda ahi en vez de
 * a la pagina de 403 (p. ej. /mi-progreso del profesor → /perfil). Las
 * peticiones de fondo reciben siempre el 403 JSON de `renderForbidden`.
 */
export const requireCapability = (capability, { redirect = null, message = null } = {}) =>
    function (req, res, next) {
        if (can(res.locals.user_session, capability)) return next();

        if (redirect && req.method === 'GET') return res.redirect(redirect);

        return renderForbidden(req, res, { message: message ?? DENIED_MESSAGES[capability] });
    };
