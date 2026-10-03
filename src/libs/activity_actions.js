/**
 * Catalogo de acciones del log de actividad (#Schemas/activity_log_schema.js).
 *
 * Fuente unica de verdad: el schema valida `action` contra este enum, el helper
 * deriva de aqui la categoria, y el panel admin arma sus filtros y sus etiquetas
 * leyendo estos mismos objetos. Agregar una accion es tocar solo este archivo.
 *
 * La convencion es `categoria.accion` en minusculas. La categoria sale del
 * prefijo del propio string (ver ACTION_CATEGORY), asi que no hay forma de que
 * las dos se desincronicen.
 *
 * Todas las acciones de aqui se escriben desde algun controlador, salvo las dos
 * marcadas "sin call site", que quedan declaradas porque la funcionalidad que
 * las provocaria todavia no existe en el repo.
 *
 * QUE NO ENTRA A ESTE CATALOGO
 * ---------------------------
 * - Respuestas a preguntas y respuestas de simulacro: son miles por usuario y
 *   ya viven en sus propias colecciones (UserAnswer, UserSimulacrum.answers).
 *   Meterlas aqui convierte el log en la coleccion mas grande de la base.
 * - Descargas de archivos: las cubre `Download` con mas detalle (pedido,
 *   suscripcion, ruta del archivo). Duplicarlas descuadra los dos paneles.
 * - Vistas de pagina y GETs de lectura: eso es morgan, no auditoria.
 */
const ACTIVITY_ACTIONS = {
    // --- auth ---------------------------------------------------------------
    LOGIN: 'auth.login',
    // Intento fallido: se guarda con status 'failed', y sin user_id cuando el
    // correo ni siquiera existe. Es la unica senal que queda de un ataque por
    // fuerza bruta, porque morgan solo escribe a stdout.
    LOGIN_FAILED: 'auth.login_failed',
    LOGOUT: 'auth.logout',
    REGISTER: 'auth.register',
    EMAIL_VERIFIED: 'auth.email_verified',
    VERIFICATION_CODE_RESENT: 'auth.verification_code_resent',
    PASSWORD_RECOVERY_REQUESTED: 'auth.password_recovery_requested',
    PASSWORD_RESET: 'auth.password_reset',

    // --- user ---------------------------------------------------------------
    PROFILE_UPDATED: 'user.profile_updated',
    // Un administrador editando la cuenta de otro. Distinta de
    // PROFILE_UPDATED, que es el usuario cambiando lo suyo.
    USER_ADMIN_UPDATED: 'user.admin_updated',
    USER_DELETED: 'user.deleted',
    USER_ACTIVATED: 'user.activated',
    // Declaradas sin instrumentar porque hoy no existe la ruta que las
    // provoque: nada en el repo escribe `User.rol` despues del registro, y el
    // panel solo sabe activar (`/user/active/:id`), nunca desactivar.
    ROLE_CHANGED: 'user.role_changed',        // sin call site
    USER_DEACTIVATED: 'user.deactivated',     // sin call site
    // Veto o readmision de un docente en la beta (`beta_teacher_blocked`). La
    // beta esta abierta a todo el profesorado, asi que esto no concede nada:
    // es el unico corte fino sobre /materiales y /mis-preguntas, y por eso tiene
    // que quedar registrado quien lo aplica y a quien.
    USER_BETA_TEACHER_CHANGED: 'user.beta_teacher_changed',

    // --- exam ---------------------------------------------------------------
    EXAM_FAVORITED: 'exam.favorited',
    EXAM_UNFAVORITED: 'exam.unfavorited',
    EXAM_CREATED: 'exam.created',
    EXAM_UPDATED: 'exam.updated',
    EXAM_PUBLISHED: 'exam.published',
    EXAM_NOTIFICATION_SENT: 'exam.notification_sent',
    EXAM_AREA_ADDED: 'exam.area_added',
    EXAM_AREA_UPDATED: 'exam.area_updated',
    EXAM_COMMENTED: 'exam.commented',
    BLOCK_CREATED: 'exam.block_created',
    BLOCK_UPDATED: 'exam.block_updated',

    // --- question -----------------------------------------------------------
    QUESTION_CREATED: 'question.created',
    QUESTION_UPDATED: 'question.updated',
    // Aprobacion: `verified` pasa de false a true. Es la accion que hoy solo
    // deja rastro en `verified_by`, un campo que la siguiente edicion pisa.
    QUESTION_VERIFIED: 'question.verified',
    QUESTION_REPORTED: 'question.reported',
    QUESTION_LIST_CREATED: 'question.list_created',
    QUESTION_LIST_QUESTION_ADDED: 'question.list_question_added',
    QUESTION_LIST_QUESTION_REMOVED: 'question.list_question_removed',
    QUESTION_DELETED: 'question.deleted',
    QUESTION_ANSWER_SET: 'question.answer_set',
    QUESTION_BULK_CREATED: 'question.bulk_created',
    QUESTION_REPORT_REVIEWED: 'question.report_reviewed',
    QUESTION_COMMENTED: 'question.commented',
    // IA: cada una de estas cuesta dinero real en Gemini y reescribe el banco
    // de preguntas en bloque, asi que son de las mas importantes del log.
    QUESTION_AI_APPLIED: 'question.ai_applied',
    QUESTION_AI_REJECTED: 'question.ai_rejected',
    QUESTION_AI_RETRIED: 'question.ai_retried',
    QUESTION_TOPICS_APPLIED: 'question.topics_applied',
    // Generacion de figuras: tambien se paga por llamada, y aplicar una figura
    // reescribe el enunciado.
    QUESTION_FIGURES_QUEUED: 'question.figures_queued',
    QUESTION_FIGURE_APPLIED: 'question.figure_applied',
    QUESTION_FIGURE_REJECTED: 'question.figure_rejected',
    QUESTION_CONFLICT_RESOLVED: 'question.conflict_resolved',

    // --- simulacrum ---------------------------------------------------------
    SIMULACRUM_ENROLLED: 'simulacrum.enrolled',
    SIMULACRUM_FINISHED: 'simulacrum.finished',
    SIMULACRUM_RETRIED: 'simulacrum.retried',
    SIMULACRUM_CREATED: 'simulacrum.created',
    SIMULACRUM_UPDATED: 'simulacrum.updated',
    SIMULACRUM_ASSEMBLED: 'simulacrum.assembled',
    SIMULACRUM_CONFIRMATION_SENT: 'simulacrum.confirmation_sent',

    // --- subscription -------------------------------------------------------
    SUBSCRIPTION_PURCHASE_REQUESTED: 'subscription.purchase_requested',
    SUBSCRIPTION_RENEWAL_REQUESTED: 'subscription.renewal_requested',
    SUBSCRIPTION_PAYMENT_APPROVED: 'subscription.payment_approved',
    SUBSCRIPTION_PAYMENT_REJECTED: 'subscription.payment_rejected',
    // El modal de verificacion ofrece tres estados (Completado, Cancelado y
    // Pendiente), asi que devolver un pago a pendiente necesita su propia
    // accion: registrarlo como rechazo diria en el panel algo que no paso.
    SUBSCRIPTION_PAYMENT_REVERTED: 'subscription.payment_reverted',
    // Alta de un PLAN en el catalogo (`Suscription`), no la suscripcion de un
    // usuario concreto: eso solo ocurre al aprobar un pago.
    SUBSCRIPTION_PLAN_CREATED: 'subscription.plan_created',
    // La escribe el cron diario de #Libs/cron.js, con actor_type 'system'.
    SUBSCRIPTION_EXPIRED: 'subscription.expired',

    // --- store --------------------------------------------------------------
    ORDER_CREATED: 'store.order_created',
    ORDER_VERIFIED: 'store.order_verified',
    ORDER_REJECTED: 'store.order_rejected',
    PRODUCT_CREATED: 'store.product_created',
    PRODUCT_UPDATED: 'store.product_updated',
    PRODUCT_DELETED: 'store.product_deleted',

    // --- teacher ------------------------------------------------------------
    TEACHER_QUESTION_CREATED: 'teacher.question_created',
    TEACHER_QUESTION_UPDATED: 'teacher.question_updated',
    TEACHER_QUESTION_DELETED: 'teacher.question_deleted',
    TEACHER_PDF_IMPORT_EXTRACTED: 'teacher.pdf_import_extracted',
    TEACHER_PDF_IMPORT_CONFIRMED: 'teacher.pdf_import_confirmed',
    TEACHER_TEMPLATE_CREATED: 'teacher.template_created',
    TEACHER_TEMPLATE_UPDATED: 'teacher.template_updated',
    TEACHER_TEMPLATE_DELETED: 'teacher.template_deleted',
    MATERIAL_CREATED: 'teacher.material_created',
    MATERIAL_UPDATED: 'teacher.material_updated',
    MATERIAL_STATE_CHANGED: 'teacher.material_state_changed',

    // --- admin (catalogos y operacion) --------------------------------------
    INSTITUTION_CREATED: 'admin.institution_created',
    INSTITUTION_UPDATED: 'admin.institution_updated',
    PROSPECT_CREATED: 'admin.prospect_created',
    PROSPECT_UPDATED: 'admin.prospect_updated',
    TEMPLATE_CREATED: 'admin.template_created',
    TEMPLATE_UPDATED: 'admin.template_updated',
    // Los iconos de "eliminar" del listado de plantillas no borran nada: solo
    // alternan el flag `public` (ver deactivateTemplateController). La accion se
    // llama por lo que de verdad hace.
    TEMPLATE_VISIBILITY_CHANGED: 'admin.template_visibility_changed',
    INCOME_MANUAL_CREATED: 'admin.income_manual_created',
    INCOME_MANUAL_DELETED: 'admin.income_manual_deleted',
    // Asignacion de trabajo editorial sobre un examen o simulacro.
    TASK_CREATED: 'admin.task_created',
    TASK_ASSIGNED: 'admin.task_assigned',
    TASK_REMOVED: 'admin.task_removed',
    // Practicas creadas al aceptar una sugerencia de /admin/practicas-sugeridas.
    PRACTICE_CREATED_FROM_SUGGESTION: 'admin.practice_created_from_suggestion',
};

const ACTIVITY_CATEGORIES = [
    'auth', 'user', 'exam', 'question', 'simulacrum',
    'subscription', 'store', 'teacher', 'admin', 'system',
];

/**
 * Categoria de cada accion, derivada del prefijo de su propio string.
 */
const ACTION_CATEGORY = Object.fromEntries(
    Object.values(ACTIVITY_ACTIONS).map((action) => [action, action.split('.')[0]])
);

/**
 * Etiquetas en espanol para la tabla del panel y para el CSV. Solo se listan las
 * acciones instrumentadas; para el resto el panel cae al string crudo, que ya es
 * legible por si solo.
 */
const ACTION_LABEL = {
    [ACTIVITY_ACTIONS.LOGIN]: 'Inicio de sesión',
    [ACTIVITY_ACTIONS.LOGIN_FAILED]: 'Inicio de sesión fallido',
    [ACTIVITY_ACTIONS.LOGOUT]: 'Cierre de sesión',
    [ACTIVITY_ACTIONS.REGISTER]: 'Registro de cuenta',
    [ACTIVITY_ACTIONS.EMAIL_VERIFIED]: 'Correo verificado',
    [ACTIVITY_ACTIONS.VERIFICATION_CODE_RESENT]: 'Reenvío de código',
    [ACTIVITY_ACTIONS.PASSWORD_RECOVERY_REQUESTED]: 'Solicitud de recuperación',
    [ACTIVITY_ACTIONS.PASSWORD_RESET]: 'Cambio de contraseña',
    [ACTIVITY_ACTIONS.PROFILE_UPDATED]: 'Perfil actualizado',
    [ACTIVITY_ACTIONS.EXAM_FAVORITED]: 'Examen a favoritos',
    [ACTIVITY_ACTIONS.EXAM_UNFAVORITED]: 'Examen quitado de favoritos',
    [ACTIVITY_ACTIONS.QUESTION_CREATED]: 'Pregunta creada',
    [ACTIVITY_ACTIONS.QUESTION_UPDATED]: 'Pregunta editada',
    [ACTIVITY_ACTIONS.QUESTION_VERIFIED]: 'Pregunta aprobada',
    [ACTIVITY_ACTIONS.QUESTION_REPORTED]: 'Pregunta reportada',
    [ACTIVITY_ACTIONS.QUESTION_LIST_CREATED]: 'Lista creada',
    [ACTIVITY_ACTIONS.QUESTION_LIST_QUESTION_ADDED]: 'Pregunta agregada a lista',
    [ACTIVITY_ACTIONS.QUESTION_LIST_QUESTION_REMOVED]: 'Pregunta quitada de lista',
    [ACTIVITY_ACTIONS.SIMULACRUM_ENROLLED]: 'Inscripción a simulacro',
    [ACTIVITY_ACTIONS.SIMULACRUM_FINISHED]: 'Simulacro finalizado',
    [ACTIVITY_ACTIONS.SIMULACRUM_RETRIED]: 'Reintento de simulacro',
    [ACTIVITY_ACTIONS.SUBSCRIPTION_PURCHASE_REQUESTED]: 'Solicitud de suscripción',
    [ACTIVITY_ACTIONS.SUBSCRIPTION_RENEWAL_REQUESTED]: 'Solicitud de renovación',
    [ACTIVITY_ACTIONS.SUBSCRIPTION_PAYMENT_APPROVED]: 'Pago aprobado',
    [ACTIVITY_ACTIONS.SUBSCRIPTION_PAYMENT_REJECTED]: 'Pago rechazado',
    [ACTIVITY_ACTIONS.SUBSCRIPTION_PAYMENT_REVERTED]: 'Pago devuelto a pendiente',
    [ACTIVITY_ACTIONS.SUBSCRIPTION_PLAN_CREATED]: 'Plan de suscripción creado',
    [ACTIVITY_ACTIONS.SUBSCRIPTION_EXPIRED]: 'Suscripción vencida',

    [ACTIVITY_ACTIONS.USER_ADMIN_UPDATED]: 'Cuenta editada por administrador',
    [ACTIVITY_ACTIONS.USER_DELETED]: 'Cuenta eliminada',
    [ACTIVITY_ACTIONS.USER_ACTIVATED]: 'Cuenta activada',
    [ACTIVITY_ACTIONS.ROLE_CHANGED]: 'Rol cambiado',
    [ACTIVITY_ACTIONS.USER_DEACTIVATED]: 'Cuenta desactivada',
    [ACTIVITY_ACTIONS.USER_BETA_TEACHER_CHANGED]: 'Bloqueo en la beta de docentes',

    [ACTIVITY_ACTIONS.EXAM_CREATED]: 'Examen creado',
    [ACTIVITY_ACTIONS.EXAM_UPDATED]: 'Examen editado',
    [ACTIVITY_ACTIONS.EXAM_PUBLISHED]: 'Examen publicado',
    [ACTIVITY_ACTIONS.EXAM_NOTIFICATION_SENT]: 'Correo masivo de examen',
    [ACTIVITY_ACTIONS.EXAM_AREA_ADDED]: 'Área agregada a examen',
    [ACTIVITY_ACTIONS.EXAM_AREA_UPDATED]: 'Área de examen editada',
    [ACTIVITY_ACTIONS.EXAM_COMMENTED]: 'Comentario en examen',
    [ACTIVITY_ACTIONS.BLOCK_CREATED]: 'Lectura creada',
    [ACTIVITY_ACTIONS.BLOCK_UPDATED]: 'Lectura editada',

    [ACTIVITY_ACTIONS.QUESTION_DELETED]: 'Pregunta eliminada',
    [ACTIVITY_ACTIONS.QUESTION_ANSWER_SET]: 'Clave de respuesta definida',
    [ACTIVITY_ACTIONS.QUESTION_BULK_CREATED]: 'Preguntas cargadas en bloque',
    [ACTIVITY_ACTIONS.QUESTION_REPORT_REVIEWED]: 'Reporte revisado',
    [ACTIVITY_ACTIONS.QUESTION_COMMENTED]: 'Comentario en pregunta',
    [ACTIVITY_ACTIONS.QUESTION_AI_APPLIED]: 'Sugerencia IA aplicada',
    [ACTIVITY_ACTIONS.QUESTION_AI_REJECTED]: 'Sugerencia IA descartada',
    [ACTIVITY_ACTIONS.QUESTION_AI_RETRIED]: 'Revisión IA reintentada',
    [ACTIVITY_ACTIONS.QUESTION_TOPICS_APPLIED]: 'Temas aplicados en bloque',
    [ACTIVITY_ACTIONS.QUESTION_CONFLICT_RESOLVED]: 'Duplicado resuelto',

    [ACTIVITY_ACTIONS.SIMULACRUM_CREATED]: 'Simulacro creado',
    [ACTIVITY_ACTIONS.SIMULACRUM_UPDATED]: 'Simulacro editado',
    [ACTIVITY_ACTIONS.SIMULACRUM_ASSEMBLED]: 'Simulacro armado',
    [ACTIVITY_ACTIONS.SIMULACRUM_CONFIRMATION_SENT]: 'Confirmación de inscripción enviada',

    [ACTIVITY_ACTIONS.ORDER_CREATED]: 'Pedido realizado',
    [ACTIVITY_ACTIONS.ORDER_VERIFIED]: 'Pedido verificado',
    [ACTIVITY_ACTIONS.ORDER_REJECTED]: 'Pedido rechazado',
    [ACTIVITY_ACTIONS.PRODUCT_CREATED]: 'Producto creado',
    [ACTIVITY_ACTIONS.PRODUCT_UPDATED]: 'Producto editado',
    [ACTIVITY_ACTIONS.PRODUCT_DELETED]: 'Producto eliminado',

    [ACTIVITY_ACTIONS.TEACHER_QUESTION_CREATED]: 'Pregunta propia creada',
    [ACTIVITY_ACTIONS.TEACHER_QUESTION_UPDATED]: 'Pregunta propia editada',
    [ACTIVITY_ACTIONS.TEACHER_QUESTION_DELETED]: 'Pregunta propia eliminada',
    [ACTIVITY_ACTIONS.TEACHER_PDF_IMPORT_EXTRACTED]: 'PDF procesado por IA',
    [ACTIVITY_ACTIONS.TEACHER_PDF_IMPORT_CONFIRMED]: 'Importación de PDF confirmada',
    [ACTIVITY_ACTIONS.TEACHER_TEMPLATE_CREATED]: 'Plantilla propia creada',
    [ACTIVITY_ACTIONS.TEACHER_TEMPLATE_UPDATED]: 'Plantilla propia editada',
    [ACTIVITY_ACTIONS.TEACHER_TEMPLATE_DELETED]: 'Plantilla propia eliminada',
    [ACTIVITY_ACTIONS.MATERIAL_CREATED]: 'Material creado',
    [ACTIVITY_ACTIONS.MATERIAL_UPDATED]: 'Material editado',
    [ACTIVITY_ACTIONS.MATERIAL_STATE_CHANGED]: 'Estado de material',

    [ACTIVITY_ACTIONS.INSTITUTION_CREATED]: 'Institución creada',
    [ACTIVITY_ACTIONS.INSTITUTION_UPDATED]: 'Institución editada',
    [ACTIVITY_ACTIONS.PROSPECT_CREATED]: 'Prospecto creado',
    [ACTIVITY_ACTIONS.PROSPECT_UPDATED]: 'Prospecto editado',
    [ACTIVITY_ACTIONS.TEMPLATE_CREATED]: 'Plantilla creada',
    [ACTIVITY_ACTIONS.TEMPLATE_UPDATED]: 'Plantilla editada',
    [ACTIVITY_ACTIONS.TEMPLATE_VISIBILITY_CHANGED]: 'Visibilidad de plantilla',
    [ACTIVITY_ACTIONS.INCOME_MANUAL_CREATED]: 'Ingreso manual registrado',
    [ACTIVITY_ACTIONS.INCOME_MANUAL_DELETED]: 'Ingreso manual eliminado',
    [ACTIVITY_ACTIONS.TASK_CREATED]: 'Tarea creada',
    [ACTIVITY_ACTIONS.TASK_ASSIGNED]: 'Tarea asignada',
    [ACTIVITY_ACTIONS.TASK_REMOVED]: 'Tarea removida',
    [ACTIVITY_ACTIONS.PRACTICE_CREATED_FROM_SUGGESTION]: 'Práctica creada desde sugerencia',
};

const CATEGORY_LABEL = {
    auth: 'Autenticación',
    user: 'Usuario',
    exam: 'Examen',
    question: 'Pregunta',
    simulacrum: 'Simulacro',
    subscription: 'Suscripción',
    store: 'Tienda',
    teacher: 'Profesor',
    admin: 'Administración',
    system: 'Sistema',
};

export { ACTIVITY_ACTIONS, ACTIVITY_CATEGORIES, ACTION_CATEGORY, ACTION_LABEL, CATEGORY_LABEL };
