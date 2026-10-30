import BannerModel from '#Models/banner_model.js';
import ExamModel from '#Models/exam_model.js';
import InstitutionModel from '#Models/institution_model.js';
import SuscriptionModel from '#Models/suscription_model.js';
import { ApiError } from '#Libs/api_error.js';
import { BANNER_PLACEMENTS, viewerAudience } from '#Libs/banner_placements.js';
import { isPremium } from '#Libs/capabilities.js';
import { buildInstitutionalPromo } from '#Libs/institution_suscription.js';
import { absoluteUrl } from '#Libs/urls.js';

// Lo que rodea al detalle de un examen en la web: banners de la barra lateral, tarjeta de
// suscripcion y examenes relacionados. Cada parte falla por separado: una consulta caida no
// tumba la pagina, que sigue sin esa parte.

const PLACEMENT = 'exam_sidebar';
const RELATED_LIMIT = 3;

// Mismo criterio que normalizeBannerLink del panel: ruta interna o URL http(s); lo demas se descarta.
const normalizeLink = (value) => {
    const link = String(value ?? '').trim().slice(0, 600);
    if (!link) return '';
    if (link.startsWith('/') && !link.startsWith('//') && !link.startsWith('/\\')) return link;
    try {
        const url = new URL(link);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
};

export const examBanners = async ({ user, institutionId, now = new Date() }) => {
    const config = BANNER_PLACEMENTS[PLACEMENT];
    const audience = viewerAudience(user);

    const and = [
        { $or: [{ start_at: null }, { start_at: { $lte: now } }] },
        { $or: [{ end_at: null }, { end_at: { $gt: now } }] },
        // Los banners de la ubicacion se limitan a los examenes de ciertas universidades.
        { $or: [{ institution_ids: { $size: 0 } }, ...(institutionId ? [{ institution_ids: String(institutionId) }] : [])] },
    ];
    if (audience) and.push({ $or: [{ audiences: { $size: 0 } }, { audiences: audience }] });

    const banners = await BannerModel.find(
        { placements: PLACEMENT, active: true, $and: and },
        { title: 1, image: 1, link_url: 1, new_tab: 1 },
    ).sort({ order: 1, created_at: -1 }).limit(10).lean().exec();

    if (banners.length === 0) return null;

    return {
        id: `banners-${PLACEMENT.replace(/_/g, '-')}`,
        ratio: config.ratio,
        mobile_ratio: config.mobile_ratio ?? config.ratio,
        banners: banners.map((banner) => {
            const link = normalizeLink(banner.link_url);
            return {
                title: banner.title,
                image: absoluteUrl(banner.image),
                image_mobile: '',
                new_tab: banner.new_tab === true,
                external: /^https?:\/\//i.test(link),
                // El enlace pasa por /b/:id (monolito), que cuenta el clic antes de redirigir.
                href: link ? `/b/${encodeURIComponent(banner._id)}?from=${PLACEMENT}` : '',
            };
        }),
    };
};

// Solo se ofrece a quien no tiene plan. Sin plan institucional activo la tarjeta cae al texto general.
export const examPromo = async ({ user, institutionId }) => {
    if (isPremium(user)) return null;

    const plan = await SuscriptionModel.findOne(
        // Sin planes exclusivos de docentes: la promo se le muestra a cualquiera.
        { state: true, restricted_to_institution: true, audience: { $ne: 'Profesor' } },
        { slug: 1, price: 1 },
    ).sort({ price: 1 }).lean().exec();

    const institution = institutionId
        ? await InstitutionModel.findById(institutionId, { name: 1, abrev: 1, exams_count: 1 }).lean().exec()
        : null;

    const promo = buildInstitutionalPromo(plan, institution ? [institution] : [], institutionId);
    if (!promo) return null;

    return {
        slug: promo.slug ?? null,
        price: promo.price ?? null,
        institution: promo.institution
            ? { id: String(promo.institution._id), abrev: promo.institution.abrev ?? null, exams_count: promo.institution.exams_count ?? 0 }
            : null,
    };
};

export const relatedExams = async ({ examId, institutionId }) => {
    // Solo lo que pinta la tarjeta: sin la proyeccion viajarian las areas y el banco de preguntas.
    const projection = { title: 1, slug: 1, image_post: 1, 'institution.image': 1 };

    let related = institutionId
        ? await ExamModel.find({ _id: { $ne: examId }, 'institution.id': institutionId, verified: true }, projection).limit(RELATED_LIMIT).lean().exec()
        : [];

    if (related.length === 0) {
        related = await ExamModel.find({ _id: { $ne: examId }, verified: true }, projection).limit(RELATED_LIMIT).lean().exec();
    }

    return related.map((exam) => ({
        slug: exam.slug,
        title: exam.title ?? null,
        image: absoluteUrl(exam.image_post || exam.institution?.image || null),
    }));
};

const settled = (result, fallback) => (result.status === 'fulfilled' ? result.value : fallback);

export const getExamExtras = async ({ examId, user }) => {
    // La institucion sale del examen, no del cliente: filtra los banners y la promo.
    const exam = await ExamModel.findOne({ _id: examId, verified: true }, { 'institution.id': 1 }).lean().exec();
    if (!exam) throw ApiError.notFound('No encontramos ese examen.');
    const institutionId = exam.institution?.id ?? null;

    const [banners, promo, related] = await Promise.allSettled([
        examBanners({ user, institutionId }),
        examPromo({ user, institutionId }),
        relatedExams({ examId, institutionId }),
    ]);

    return { banners: settled(banners, null), promo: settled(promo, null), related: settled(related, []) };
};
