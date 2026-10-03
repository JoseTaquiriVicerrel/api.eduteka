import path from 'node:path';
import DownloadModel from '#Models/download_model.js';
import ExamModel from '#Models/exam_model.js';
import OrderModel from '#Models/order_model.js';
import ProductModel from '#Models/product_model.js';
import { ApiError } from '#Libs/api_error.js';
import { hasActiveSuscription, isAdmin } from '#Libs/capabilities.js';
import { logger } from '#Libs/logger.js';
import { resolveStoredFile } from './download.files.js';

// Quien puede descargar que. Cada funcion devuelve el archivo resuelto y los datos
// de auditoria, o lanza el ApiError que corresponde. Se usan tanto en la descarga con
// Bearer como al canjear un enlace firmado (donde se vuelve a comprobar todo).

const normalizeAreas = (areas) =>
    (Array.isArray(areas) ? areas : []).map((area) => (typeof area === 'string' ? area : area?.abrev)).filter(Boolean);

const extensionOf = (storedPath) => path.extname(storedPath ?? '');

/** Nombre con el que el usuario guarda un archivo de un producto. */
export const productFileName = (file) => `${file.name ?? 'archivo'}${extensionOf(file.path)}`;

/** Archivos de un producto a los que da derecho un item del pedido. */
export const entitledFiles = (product, item) => {
    const files = Array.isArray(product?.files) ? product.files : [];
    // Un examen vendido por areas solo da los archivos de las areas compradas.
    if (product?.type === 'Examen' && !product.unique) {
        const bought = new Set(normalizeAreas(item?.areas));
        return files.filter((file) => bought.has(file.area));
    }
    return files;
};

/**
 * Archivo de un pedido VERIFICADO del propio usuario. Un pedido de otro usuario es un
 * 404 (no se revela que existe); uno propio sin verificar, un 403.
 */
export const resolveOrderFile = async ({ user, orderId, productId, fileName }) => {
    const order = await OrderModel.findOne({ _id: orderId, user_id: user._id }).lean().exec();
    if (!order) throw ApiError.notFound('No encontramos ese pedido.');
    if (order.status !== 'verified') throw ApiError.forbidden('Tu pedido aún no está verificado.');

    const item = (order.items ?? []).find((entry) => String(entry.product_id) === productId);
    if (!item) throw ApiError.notFound('Ese producto no está en el pedido.');

    const product = await ProductModel.findById(productId, { name: 1, type: 1, unique: 1, files: 1 }).lean().exec();
    if (!product) throw ApiError.notFound('El producto ya no existe.');

    const file = (product.files ?? []).find((entry) => entry.name === fileName);
    if (!file) throw ApiError.notFound('No encontramos ese archivo.');

    if (!entitledFiles(product, item).some((entry) => entry.name === file.name && entry.path === file.path)) {
        throw ApiError.forbidden('No tienes acceso a esta área.');
    }

    const stored = await resolveStoredFile(file.path);
    if (!stored) throw ApiError.notFound('El archivo ya no está disponible.');

    return {
        stored,
        downloadName: productFileName(file),
        audit: {
            source: 'store',
            resource_type: 'product',
            resource_id: product._id,
            resource_name: product.name,
            area: file.area,
            file_name: productFileName(file),
            file_path: file.path,
            order_id: order._id,
        },
    };
};

/**
 * Permiso para descargar los examenes de la suscripcion: administrador, o suscripcion
 * VIGENTE (estado y fecha). Con un plan restringido a una institucion, solo los examenes
 * de esa institucion.
 */
export const assertExamDownloadAllowed = (user, exam) => {
    if (isAdmin(user)) return;
    if (!hasActiveSuscription(user)) throw ApiError.subscriptionRequired('Necesitas una suscripción activa para descargar exámenes.');

    const { suscription } = user;
    const examInstitution = exam.institution?.id;
    if (examInstitution && suscription.institution_id && String(suscription.institution_id) !== String(examInstitution)) {
        throw ApiError.institutionRestricted('No tienes acceso a contenidos de esta institución.');
    }
};

/** Archivo PDF de un examen (con suscripcion). `area` es la clave dentro de `exam.files`. */
export const resolveExamFile = async ({ user, slug, area }) => {
    const exam = await ExamModel.findOne({ slug, verified: true }, { title: 1, slug: 1, institution: 1, files: 1 }).lean().exec();
    if (!exam) throw ApiError.notFound('No encontramos ese examen.');

    assertExamDownloadAllowed(user, exam);

    const withFile = Object.entries(exam.files && typeof exam.files === 'object' ? exam.files : {}).filter(([, file]) => file?.path);
    const entry = area ? withFile.find(([key]) => key === area) : withFile[0];
    if (!entry) throw ApiError.notFound('Este examen no tiene un archivo para descargar.');

    const [areaKey, file] = entry;
    const stored = await resolveStoredFile(file.path);
    if (!stored) throw ApiError.notFound('El archivo ya no está disponible.');

    const { suscription } = user;
    return {
        stored,
        downloadName: path.basename(file.path),
        audit: {
            source: 'subscription',
            resource_type: 'exam',
            resource_id: exam._id,
            resource_slug: exam.slug,
            resource_name: exam.title,
            area: areaKey,
            file_name: path.basename(file.path),
            file_path: file.path,
            // Queda en null cuando descarga un administrador sin suscripcion.
            subscription: suscription
                ? { name: suscription.name, end_date: suscription.end_date, institution_id: suscription.institution_id }
                : null,
        },
    };
};

/**
 * Registra una descarga YA autorizada. Es auditoria: se llama sin `await` y nunca falla
 * hacia el cliente (una descarga legitima no puede romperse porque fallo su log).
 */
export const logDownload = async (req, user, audit) => {
    try {
        await DownloadModel.create({
            ...audit,
            user_id: user._id,
            user_rol: user.rol,
            user_account_type: user.account_type,
            ip: req.ip,
            user_agent: (req.get('user-agent') ?? '').slice(0, 500),
        });
    } catch (error) {
        logger.error({ err: error.message }, 'No se pudo registrar la descarga');
    }
};
