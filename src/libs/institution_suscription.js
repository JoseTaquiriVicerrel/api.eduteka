// Reglas de la suscripcion institucional (planes con restricted_to_institution).
//
// Funciones puras: reciben el plan y las stats de instituciones ya cargados
// (ver #Services/institution-suscription.service.js) para poder probarlas sin
// Mongo ni Redis.

// Piso de examenes verificados para que una institucion se pueda elegir en una
// suscripcion institucional y se promocione con su nombre. El dashboard admin
// usa el mismo valor para marcar en rojo a las que tienen suscriptores y no lo
// alcanzan.
export const MIN_EXAMS_INSTITUTION = 10;

// Mismo reemplazo que el titulo de /examenes/universidad/:institution.
const displayAbrev = (abrev) => (abrev ?? '').replace(/^unmsm$/i, 'SAN MARCOS');

export const isEligibleInstitution = (stats, institutionId) => {
    if (!institutionId) return false;
    const institution = (stats ?? []).find((doc) => String(doc._id) === String(institutionId));
    return (institution?.exams_count ?? 0) >= MIN_EXAMS_INSTITUTION;
};

export const eligibleInstitutions = (stats) =>
    (stats ?? []).filter((doc) => (doc.exams_count ?? 0) >= MIN_EXAMS_INSTITUTION);

// null si no hay plan institucional activo: las tarjetas caen al texto de
// siempre. Con plan, `institution` solo viene si llega al minimo; si no, la
// tarjeta muestra el mensaje general "de tu universidad".
export const buildInstitutionalPromo = (plan, stats, institutionId) => {
    if (!plan) return null;

    const institution = isEligibleInstitution(stats, institutionId)
        ? stats.find((doc) => String(doc._id) === String(institutionId))
        : null;

    return {
        slug: plan.slug,
        price: plan.price,
        institution: institution ? {
            _id: institution._id,
            name: institution.name,
            abrev: displayAbrev(institution.abrev),
            exams_count: institution.exams_count,
        } : null,
    };
};
