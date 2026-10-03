// Capacidades derivadas del usuario (especificacion §4). Se calculan en el
// servidor y viajan en /auth/me; el cliente solo decide que pantallas mostrar,
// nunca que puede hacer: cada endpoint vuelve a comprobarlo.
//
// Reglas (las mismas del monolito, #Libs/permissions.js):
//  - El estudiante practica, rinde simulacros y acumula progreso.
//  - El profesor construye material: no responde ni rinde simulacros.
//  - El administrador puede todo.
//  - Descargar examenes es premium (suscripcion activa o administrador).

export const CAPABILITIES = Object.freeze({
    TRACK_PROGRESS: 'TRACK_PROGRESS',
    DOWNLOAD_EXAMS: 'DOWNLOAD_EXAMS',
    TAKE_SIMULACRUM: 'TAKE_SIMULACRUM',
    USE_PRACTICES: 'USE_PRACTICES',
    TEACHER_TOOLS: 'TEACHER_TOOLS',
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

export const capabilitiesFor = (user, now = new Date()) => {
    const result = [];

    if (isAdmin(user)) {
        result.push(
            CAPABILITIES.USE_PRACTICES,
            CAPABILITIES.TAKE_SIMULACRUM,
            CAPABILITIES.TRACK_PROGRESS,
            CAPABILITIES.TEACHER_TOOLS,
        );
    } else if (isTeacher(user)) {
        result.push(CAPABILITIES.TEACHER_TOOLS);
    } else {
        result.push(CAPABILITIES.USE_PRACTICES, CAPABILITIES.TAKE_SIMULACRUM, CAPABILITIES.TRACK_PROGRESS);
    }

    if (isPremium(user, now)) result.push(CAPABILITIES.DOWNLOAD_EXAMS);

    return result;
};
