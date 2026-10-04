import { isPremium } from '#Libs/capabilities.js';

// Topes que depende del plan (especificacion de suscripciones §4.2). Un unico lugar los
// resuelve: `limitsFor(user)`. Los de materiales y plantillas se exigen en la web (la app
// solo los muestra); el de preguntas por lista lo exige #Modules/lists.
//
// Con plan activo (o administrador) manda `suscription.limits.<tope>` si es un entero
// positivo; si no, el valor base. Sin plan rige siempre el base «sin plan». Un valor no
// valido (0, negativo, decimal, texto) se ignora: nunca bloquea.

export const BASE_LIMITS_NO_PLAN = Object.freeze({ list_questions: 30, materials: 20, templates: 10 });
export const BASE_LIMITS_WITH_PLAN = Object.freeze({ list_questions: 50, materials: 20, templates: 10 });

export const LIMIT_KEYS = Object.freeze(Object.keys(BASE_LIMITS_NO_PLAN));

const isPositiveInteger = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0;

export const limitsFor = (user, now = new Date()) => {
    const premium = isPremium(user, now);
    const base = premium ? BASE_LIMITS_WITH_PLAN : BASE_LIMITS_NO_PLAN;
    const own = premium ? user?.suscription?.limits : null;

    return Object.fromEntries(LIMIT_KEYS.map((key) => [key, isPositiveInteger(own?.[key]) ? own[key] : base[key]]));
};

/** Topes del plan tal como se guardan: solo las claves conocidas con enteros positivos. */
export const pickPlanLimits = (limits) => {
    const picked = Object.fromEntries(LIMIT_KEYS.filter((key) => isPositiveInteger(limits?.[key])).map((key) => [key, limits[key]]));
    return Object.keys(picked).length > 0 ? picked : null;
};
