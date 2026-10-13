// Version vigente de los Terminos y la Politica de Privacidad. DEBE coincidir con TERMS_VERSION de la web
// (eduteka/src/libs/legal_versions.js): se guarda por usuario al registrarse como prueba de que version
// acepto y cuando. Subirla en los dos sitios cada vez que cambien de forma importante.
export const TERMS_VERSION = '2.0';

/**
 * Campos de aceptacion para un usuario nuevo. `marketing` es el consentimiento opcional de novedades,
 * separado de la aceptacion de terminos (misma forma que la web).
 */
export const buildConsentFields = ({ marketing = false } = {}) => {
    const now = new Date();
    return {
        terms_version: TERMS_VERSION,
        terms_accepted_at: now,
        notification_consented_at: marketing ? now : null,
    };
};
