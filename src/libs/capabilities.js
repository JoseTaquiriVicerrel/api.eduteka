// Capacidades derivadas del usuario (especificacion §4). Se calculan en el
// servidor y viajan en /auth/me; el cliente solo decide que pantallas mostrar,
// nunca que puede hacer: cada endpoint vuelve a comprobarlo.
//
// Reglas (las mismas del monolito, #Libs/permissions.js):
//  - El estudiante practica, rinde simulacros y acumula progreso.
//  - El profesor ve la respuesta directamente: no responde, no rinde simulacros ni mide progreso.
//  - El administrador puede todo, pero como estudiante: no ve la clave de las practicas.
//  - Descargar examenes no es una capacidad sino un plan activo (requireSubscription).

export const CAPABILITIES = Object.freeze({
    ANSWER_QUESTIONS: 'answer_questions',
    TAKE_PRACTICE: 'take_practice',
    TAKE_SIMULACRUM: 'take_simulacrum',
    TRACK_PROGRESS: 'track_progress',
    VIEW_ANSWERS_DIRECTLY: 'view_answers_directly',
    BUY_MATERIALS: 'buy_materials',
    DOWNLOAD_MATERIALS: 'download_materials',
    // Crear contenido: solo en la web por ahora; la app unicamente los consume.
    CREATE_PRACTICE: 'create_practice',
    MANAGE_QUESTIONS: 'manage_questions',
    MANAGE_MATERIALS: 'manage_materials',
    MANAGE_TEMPLATES: 'manage_templates',
});

export const isAdmin = (user) => user?.rol === 'Administrador';

export const isTeacher = (user) => !isAdmin(user) && user?.account_type === 'Profesor';

/**
 * Suscripcion vigente. El estado 'activo' solo cambia cuando corre el cron diario
 * del monolito (09:00), asi que entre el vencimiento y esa corrida el estado
 * seguiria diciendo 'activo'. Se comprueba tambien la fecha. `end_date` nulo es
 * una suscripcion sin vencimiento (lifetime).
 */
export const hasActiveSuscription = (user, now = new Date()) => {
    const suscription = user?.suscription;
    if (suscription?.status !== 'activo') return false;
    if (!suscription.end_date) return true;
    const end = new Date(suscription.end_date);
    return Number.isNaN(end.getTime()) || end > now;
};

export const isPremium = (user, now = new Date()) => isAdmin(user) || hasActiveSuscription(user, now);

const TEACHER_SET = [
    CAPABILITIES.VIEW_ANSWERS_DIRECTLY,
    CAPABILITIES.CREATE_PRACTICE,
    CAPABILITIES.MANAGE_QUESTIONS,
    CAPABILITIES.MANAGE_MATERIALS,
    CAPABILITIES.MANAGE_TEMPLATES,
];
const STUDENT_SET = [
    CAPABILITIES.ANSWER_QUESTIONS,
    CAPABILITIES.TAKE_PRACTICE,
    CAPABILITIES.TAKE_SIMULACRUM,
    CAPABILITIES.TRACK_PROGRESS,
];

export const capabilitiesFor = (user) => {
    // Comprar y descargar materiales es de toda cuenta con sesion.
    const common = [CAPABILITIES.BUY_MATERIALS, CAPABILITIES.DOWNLOAD_MATERIALS];
    if (isAdmin(user)) return [...STUDENT_SET, ...common, ...TEACHER_SET.filter((c) => c !== CAPABILITIES.VIEW_ANSWERS_DIRECTLY)];
    if (isTeacher(user)) return [...TEACHER_SET, ...common];
    return [...STUDENT_SET, ...common];
};

/** Docentes: ven la clave y la explicacion de preguntas y practicas sin responder (view_answers_directly). */
export const canViewAnswersDirectly = (user) => capabilitiesFor(user).includes(CAPABILITIES.VIEW_ANSWERS_DIRECTLY);

/**
 * Quien ve la clave y la explicacion de un examen o de un solucionario sin haber rendido:
 * docentes (view_answers_directly) y administradores. Distinto de la capacidad: el
 * administrador la usa para revisar contenido, pero en las practicas se comporta como estudiante.
 */
export const canSeeSolutions = (user) => isAdmin(user) || isTeacher(user);
