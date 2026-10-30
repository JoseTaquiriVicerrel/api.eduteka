import { isAdmin, hasActiveSuscription, isTeacher } from '#Libs/capabilities.js';

// Ubicaciones de banners y publico al que se dirigen. Misma lista que el panel del monolito
// (src/libs/banner_placements.js): la API solo LEE los banners, los administra el panel.

export const BANNER_PLACEMENTS = Object.freeze({
    exam_sidebar: { ratio: '1 / 1', by_institution: true },
    home_hero: { ratio: '16 / 5', mobile_ratio: '1 / 1', by_institution: false },
});

export const PLACEMENT_KEYS = Object.freeze(Object.keys(BANNER_PLACEMENTS));
export const DEFAULT_PLACEMENT = 'exam_sidebar';

export const AUDIENCE_KEYS = Object.freeze([
    'guest', 'student_free', 'student_subscribed', 'teacher_free', 'teacher_subscribed',
]);

/** Grupo del visitante. El administrador devuelve null: ve todos los banners para poder revisarlos. */
export const viewerAudience = (user) => {
    if (isAdmin(user)) return null;
    if (!user) return 'guest';
    const subscribed = hasActiveSuscription(user);
    if (isTeacher(user)) return subscribed ? 'teacher_subscribed' : 'teacher_free';
    return subscribed ? 'student_subscribed' : 'student_free';
};
