import ExamModel from '#Models/exam_model.js';
import OrderModel from '#Models/order_model.js';
import ProductModel from '#Models/product_model.js';
import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { hasActiveSuscription, isAdmin } from '#Libs/capabilities.js';
import { skipOf } from '#Libs/paginate.js';
import { DOWNLOAD_LINK_TTL_SECONDS, signDownloadToken, verifyDownloadToken } from '#Libs/tokens.js';
import { absoluteUrl } from '#Libs/urls.js';
import { AUTH_USER_FIELDS } from '#Middlewares/authenticate.js';
import UserModel from '#Models/user_model.js';
import { entitledFiles, productFileName, resolveExamFile, resolveOrderFile } from './download.access.js';
import { resolveStoredFile } from './download.files.js';

// Lista de archivos a los que el usuario tiene derecho y enlaces de descarga.

const API_PREFIX = '/api/v1';
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const publicUrl = (route) => `${settings.app.apiUrl ?? ''}${API_PREFIX}${route}`;

// --- Referencias opacas a un archivo ----------------------------------------
// `id` de un archivo en las listas y en POST /descargas/:id/enlace. Es solo una
// referencia: al usarla se vuelve a comprobar el permiso, asi que no hace falta
// firmarla.

const encodeRef = (ref) => Buffer.from(JSON.stringify(ref)).toString('base64url');

const decodeRef = (id) => {
    try {
        const ref = JSON.parse(Buffer.from(String(id), 'base64url').toString('utf8'));
        const valid = (ref?.k === 'o' && [ref.o, ref.p, ref.f].every((v) => typeof v === 'string'))
            || (ref?.k === 'e' && typeof ref.s === 'string' && (ref.a === undefined || typeof ref.a === 'string'));
        return valid ? ref : null;
    } catch {
        return null;
    }
};

const orderUrl = (orderId, productId, fileName) =>
    publicUrl(`/descargas/pedidos/${encodeURIComponent(orderId)}/${encodeURIComponent(productId)}/${encodeURIComponent(fileName)}`);

const examUrl = (slug, area) => publicUrl(`/examenes/${encodeURIComponent(slug)}/pdf${area ? `?area=${encodeURIComponent(area)}` : ''}`);

const extensionLabel = (product, storedPath) => {
    const fromPath = (storedPath ?? '').split('.').pop()?.toUpperCase();
    return product?.type_file ?? (fromPath && fromPath.length <= 5 ? fromPath : null);
};

// --- Archivos de pedidos ----------------------------------------------------

const serializeOrderFile = async ({ order, product, file, available }) => {
    const stored = available ? await resolveStoredFile(file.path) : null;
    const name = productFileName(file);
    return {
        id: encodeRef({ k: 'o', o: order._id, p: String(product._id), f: file.name }),
        name,
        type_file: extensionLabel(product, file.path),
        area: file.area ?? null,
        size: stored?.size ?? null,
        source: 'order',
        // Falta en el servidor aunque el pedido este verificado.
        available: available && Boolean(stored),
        download_url: available && stored ? orderUrl(order._id, String(product._id), file.name) : null,
    };
};

const loadProducts = async (orders) => {
    const ids = [...new Set(orders.flatMap((order) => (order.items ?? []).map((item) => String(item.product_id))))];
    const products = ids.length
        ? await ProductModel.find({ _id: { $in: ids } }, { name: 1, type: 1, unique: 1, type_file: 1, files: 1, poster: 1 }).lean().exec()
        : [];
    return new Map(products.map((product) => [String(product._id), product]));
};

/** Archivos comprados (pedidos verificados), todos: son pocos por usuario. */
export const listOrderFiles = async (user) => {
    const orders = await OrderModel.find({ user_id: user._id, status: 'verified' }).sort({ created_at: -1 }).lean().exec();
    const products = await loadProducts(orders);

    const entries = [];
    for (const order of orders) {
        for (const item of order.items ?? []) {
            const product = products.get(String(item.product_id));
            if (!product) continue;
            for (const file of entitledFiles(product, item)) entries.push({ order, product, file });
        }
    }

    const items = await Promise.all(entries.map(({ order, product, file }) => serializeOrderFile({ order, product, file, available: true })));
    return { items, total: items.length };
};

// --- Examenes de la suscripcion ---------------------------------------------

/** Plan de suscripcion visto desde las descargas. */
export const subscriptionAccess = (user) => {
    const premium = isAdmin(user) || hasActiveSuscription(user);
    const plan = user.suscription ?? {};
    return {
        premium,
        plan,
        lockedInstitution: !isAdmin(user) && plan.restricted_to_institution ? plan.institution_id ?? null : null,
    };
};

/**
 * Examenes con archivo que la suscripcion permite descargar, un elemento por archivo.
 * Con un plan restringido a una institucion solo salen los de esa; sin restriccion se
 * puede filtrar por `institution`, `modality` y titulo. Pagina por EXAMEN.
 */
export const listExamFiles = async (user, { institution, modality, q, page, limit }) => {
    const { premium, lockedInstitution } = subscriptionAccess(user);
    if (!premium) throw ApiError.subscriptionRequired('Necesitas una suscripción activa para descargar exámenes.');

    const filter = { verified: true, files: { $exists: true, $ne: null } };
    const institutionId = lockedInstitution ?? institution;
    if (institutionId) filter['institution.id'] = institutionId;
    if (modality) filter.modality = modality;

    const search = String(q ?? '').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (search) filter.title = new RegExp(escapeRegex(search), 'i');

    const [exams, total] = await Promise.all([
        ExamModel.find(filter, { title: 1, slug: 1, modality: 1, institution: 1, files: 1 })
            .sort({ created_at: -1, _id: 1 })
            .skip(skipOf({ page, limit }))
            .limit(limit)
            .lean()
            .exec(),
        ExamModel.countDocuments(filter).exec(),
    ]);

    const entries = exams.flatMap((exam) =>
        Object.entries(exam.files && typeof exam.files === 'object' ? exam.files : {})
            .filter(([, file]) => file?.path)
            .map(([area, file]) => ({ exam, area, file })));

    const items = await Promise.all(entries.map(async ({ exam, area, file }) => {
        const stored = await resolveStoredFile(file.path);
        return {
            id: encodeRef({ k: 'e', s: exam.slug, a: area }),
            name: `${exam.title} - ${file.title ?? area}`,
            type_file: stored?.extension?.toUpperCase() ?? null,
            area,
            size: stored?.size ?? null,
            source: 'exam',
            exam: { id: exam._id, slug: exam.slug, title: exam.title, modality: exam.modality ?? null, institution: exam.institution?.abrev ?? null },
            available: Boolean(stored),
            download_url: stored ? examUrl(exam.slug, area) : null,
        };
    }));

    return { items, total };
};

// --- Recursos del usuario (compras + suscripcion) ---------------------------

const MAX_RESOURCE_ORDERS = 100;

export const getResources = async (user) => {
    // Pedidos verificados y pendientes (como la web); los pendientes muestran sus archivos sin enlace.
    const orders = await OrderModel.find({ user_id: user._id, status: { $in: ['verified', 'pending'] } })
        .sort({ created_at: -1 })
        .limit(MAX_RESOURCE_ORDERS)
        .lean()
        .exec();
    const products = await loadProducts(orders);

    const serializedOrders = await Promise.all(orders.map(async (order) => ({
        id: order._id,
        status: order.status,
        total: order.total ?? 0,
        discount: order.discount ?? 0,
        created_at: order.created_at ? new Date(order.created_at).toISOString() : null,
        items: await Promise.all((order.items ?? []).map(async (item) => {
            const product = products.get(String(item.product_id));
            const files = product
                ? await Promise.all(entitledFiles(product, item).map((file) =>
                    serializeOrderFile({ order, product, file, available: order.status === 'verified' })))
                : [];
            return {
                product: {
                    id: String(item.product_id),
                    name: product?.name ?? item.name ?? null,
                    type: product?.type ?? null,
                    poster: product?.poster ? absoluteUrl(product.poster) : null,
                },
                quantity: item.quantity ?? 1,
                areas: normalizeAreaNames(item.areas),
                files,
            };
        })),
    })));

    const { premium, plan, lockedInstitution } = subscriptionAccess(user);
    const end = plan.end_date ? new Date(plan.end_date) : null;

    return {
        orders: serializedOrders,
        subscription: {
            active: premium,
            plan_name: premium ? plan.name ?? null : null,
            end_date: premium && end && !Number.isNaN(end.getTime()) ? end.toISOString() : null,
            // Con plan restringido solo se descargan los examenes de esta institucion.
            locked_institution: premium ? lockedInstitution : null,
            exams_url: premium ? publicUrl('/descargas?source=exam') : null,
        },
    };
};

const normalizeAreaNames = (areas) =>
    (Array.isArray(areas) ? areas : []).map((area) => (typeof area === 'string' ? area : area?.abrev ?? area?.title)).filter(Boolean);

// --- Enlaces firmados -------------------------------------------------------

/** Resuelve una referencia a su archivo, comprobando el permiso del usuario. */
const resolveRef = (user, ref) => (ref.k === 'o'
    ? resolveOrderFile({ user, orderId: ref.o, productId: ref.p, fileName: ref.f })
    : resolveExamFile({ user, slug: ref.s, area: ref.a }));

/**
 * Enlace de un solo archivo, valido 60 s, para el DownloadManager de Android (que no
 * puede enviar el Bearer). Antes de firmarlo ya se comprueba el permiso.
 */
export const createDownloadLink = async ({ user, id }) => {
    const ref = decodeRef(id);
    if (!ref) throw ApiError.notFound('No encontramos ese archivo.');

    await resolveRef(user, ref);

    return {
        url: `${publicUrl('/descargas/archivo')}?token=${encodeURIComponent(await signDownloadToken(user._id, id))}`,
        expires_in: DOWNLOAD_LINK_TTL_SECONDS,
    };
};

/** Canjea un enlace: el permiso se vuelve a comprobar (la suscripcion pudo vencer en esos segundos). */
export const redeemDownloadLink = async (token) => {
    let payload;
    try {
        payload = await verifyDownloadToken(token);
    } catch {
        throw ApiError.unauthenticated('El enlace de descarga venció. Pídelo de nuevo.');
    }

    const user = await UserModel.findById(payload.uid, AUTH_USER_FIELDS).lean().exec();
    if (!user || user.state === false) throw ApiError.unauthenticated('El enlace de descarga ya no es válido.');

    const ref = decodeRef(payload.ref);
    if (!ref) throw ApiError.notFound('No encontramos ese archivo.');

    return { user, ...(await resolveRef(user, ref)) };
};

