import OrderModel from '#Models/order_model.js';
import ProductModel from '#Models/product_model.js';
import { settings } from '#Config/settings.js';
import { ACTIVITY_ACTIONS } from '#Libs/activity_actions.js';
import { ApiError } from '#Libs/api_error.js';
import { deleteCapture, saveCapture } from '#Libs/capture_storage.js';
import { del, setNX } from '#Libs/kv.js';
import { sendMail } from '#Libs/mailer.js';
import { skipOf } from '#Libs/paginate.js';
import { buildSelectableAreas } from '#Libs/product_areas.js';
import { safeSearchRegex } from '#Libs/text_utils.js';
import { absoluteUrl, absolutizeHtml } from '#Libs/urls.js';
import { logUserActivity } from '#Libs/user_activity.js';
import { CART_PRODUCT_PROJECTION, buildCart, serializeCartLine, toOrderItem, totalsOf } from './store.cart.js';

// Tienda: catalogo de productos, carrito (que vive en el cliente), checkout con
// comprobante y pedidos del usuario. La verificacion del comprobante es MANUAL: el pedido
// queda 'pending' hasta que un administrador lo apruebe en el panel del monolito (la web
// ademas lo pasa por IA; la API no, igual que en las inscripciones a simulacros).

export const CURRENCY = 'PEN';

// Doble toque en "Pagar": el mismo importe pendiente en esta ventana se trata como el
// mismo pedido (mismo criterio que la web).
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const CHECKOUT_LOCK_SECONDS = 15;

const iso = (value) => (value ? new Date(value).toISOString() : null);

// --- Catalogo ---------------------------------------------------------------

const publicAreas = (product) => buildSelectableAreas(product)
    .map(({ abrev, label, title, description, checked, locked }) => ({ abrev, label, title, description, checked, locked }));

const serializeProductSummary = (product) => ({
    id: product._id,
    name: product.name ?? null,
    slug: product.slug ?? null,
    type: product.type ?? null,
    type_file: product.type_file ?? null,
    // Precio POR AREA: un examen con dos areas cuesta el doble (y tiene descuento).
    price: Number(product.price) || 0,
    currency: CURRENCY,
    poster: product.poster ? absoluteUrl(product.poster) : null,
    unique: Boolean(product.unique),
    areas: publicAreas(product),
});

export const listProducts = async ({ type, q, page, limit }) => {
    const filter = { state: true };
    if (type) filter.type = type;
    if (q?.trim()) filter.name = safeSearchRegex(q.trim());

    const [docs, total] = await Promise.all([
        ProductModel.find(filter, { ...CART_PRODUCT_PROJECTION, created_at: 1 })
            .sort({ created_at: -1, _id: 1 })
            .skip(skipOf({ page, limit }))
            .limit(limit)
            .lean()
            .exec(),
        ProductModel.countDocuments(filter).exec(),
    ]);

    return { items: docs.map(serializeProductSummary), total };
};

export const getProduct = async (slug) => {
    // Un examen convertido en producto hereda el slug del examen; si se repite, el mas reciente.
    const product = await ProductModel.findOne({ slug, state: true }, { ...CART_PRODUCT_PROJECTION, description: 1, images: 1, files: 1 })
        .sort({ created_at: -1 })
        .lean()
        .exec();
    if (!product) throw ApiError.notFound('No encontramos ese producto.');

    return {
        ...serializeProductSummary(product),
        description: absolutizeHtml(product.description ?? null),
        images: (product.images ?? []).filter(Boolean).map(absoluteUrl),
        // Que incluye la compra. La ruta en disco (`files[].path`) nunca sale.
        files: (product.files ?? []).map((file) => ({ name: file.name ?? null, area: file.area ?? null })),
    };
};

// --- Carrito ----------------------------------------------------------------

const loadCartProducts = async (items) => {
    const ids = [...new Set(items.map((item) => item.product_id))];
    const products = await ProductModel.find({ _id: { $in: ids }, state: true }, CART_PRODUCT_PROJECTION).lean().exec();
    return new Map(products.map((product) => [String(product._id), product]));
};

/** Recalcula un carrito del cliente: lineas, descuentos, total y productos que ya no se venden. */
export const resolveCart = async (items) => {
    const { lines, unavailable } = buildCart(items, await loadCartProducts(items));
    return {
        items: lines.map(serializeCartLine),
        unavailable,
        ...totalsOf(lines),
        currency: CURRENCY,
    };
};

// --- Pedidos ----------------------------------------------------------------

const serializeOrder = (order) => {
    const total = order.total ?? 0;
    const discount = order.discount ?? 0;
    return {
        id: order._id,
        status: order.status ?? 'pending',
        // Motivo de un rechazo y nota del administrador.
        status_reason: order.status === 'rejected' ? order.status_reason ?? null : null,
        message: order.message ?? null,
        payment_method: order.payment_method ?? null,
        // La ruta del comprobante es privada: solo se dice si existe.
        has_payment_proof: Boolean(order.payment_proof),
        items: (order.items ?? []).map((item) => {
            const areas = (Array.isArray(item.areas) ? item.areas : [])
                .map((area) => (typeof area === 'string' ? { abrev: area, title: area } : { abrev: area?.abrev ?? null, title: area?.title ?? null }));
            return {
                product_id: item.product_id,
                name: item.name ?? null,
                unit_price: item.price ?? 0,
                quantity: item.quantity ?? 1,
                areas,
            };
        }),
        subtotal: Math.round((total + discount) * 100) / 100,
        discount,
        total,
        currency: CURRENCY,
        created_at: iso(order.created_at),
        updated_at: iso(order.updated_at),
    };
};

export const listOrders = async ({ user, status, page, limit }) => {
    const filter = { user_id: user._id };
    if (status) filter.status = status;

    const [docs, total] = await Promise.all([
        OrderModel.find(filter, { payment_proof: 1, items: 1, total: 1, discount: 1, payment_method: 1, status: 1, status_reason: 1, message: 1, created_at: 1, updated_at: 1 })
            .sort({ created_at: -1, _id: 1 })
            .skip(skipOf({ page, limit }))
            .limit(limit)
            .lean()
            .exec(),
        OrderModel.countDocuments(filter).exec(),
    ]);
    return { items: docs.map(serializeOrder), total };
};

/** Pedido propio. Uno ajeno es 404, igual que uno inexistente. */
export const getOrder = async ({ user, id }) => {
    const order = await OrderModel.findOne({ _id: id, user_id: user._id }, { ai_analysis: 0 }).lean().exec();
    if (!order) throw ApiError.notFound('No encontramos ese pedido.');
    return serializeOrder(order);
};

// --- Checkout ---------------------------------------------------------------

const assertPaymentsEnabled = () => {
    if (!settings.app.paymentsEnabled) throw ApiError.forbidden('Las compras no están disponibles por ahora.');
};

/**
 * Registra un pedido con su comprobante. Todo se valida ANTES de escribir el archivo: un
 * carrito invalido nunca deja un comprobante huerfano en disco.
 */
export const checkout = async ({ req, user, body, capture }) => {
    assertPaymentsEnabled();
    if (!capture) throw ApiError.validation([{ field: 'payment_proof', message: 'Adjunta el comprobante de pago.' }]);

    const { lines, unavailable, problems } = buildCart(body.items, await loadCartProducts(body.items), { strict: true });
    if (unavailable.length > 0) {
        throw new ApiError(409, 'CONFLICT', 'Algunos productos de tu carrito ya no están disponibles.', {
            details: unavailable.map((id) => ({ field: 'items', message: `Producto no disponible: ${id}` })),
        });
    }
    if (problems.length > 0) throw ApiError.validation(problems);

    const { total, discount } = totalsOf(lines);
    if (total <= 0) throw ApiError.validation([{ field: 'items', message: 'El total del pedido no es válido.' }]);

    if (body.expected_total !== undefined && Math.abs(body.expected_total - total) >= 0.01) {
        throw ApiError.conflict(`El precio de tu carrito cambió: el total ahora es S/ ${total.toFixed(2)}. Revísalo antes de pagar.`);
    }

    const lockKey = `order-lock:${user._id}`;
    if (!(await setNX(lockKey, CHECKOUT_LOCK_SECONDS))) throw ApiError.conflict('Tu pedido aún se está procesando.');

    try {
        const duplicate = await OrderModel.exists({
            user_id: user._id,
            total,
            status: 'pending',
            created_at: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
        }).exec();
        if (duplicate) throw ApiError.conflict('Ya tienes un pedido reciente en revisión con este mismo importe.');

        const paymentProof = await saveCapture(capture, { target: 'order', field: 'payment_proof' });
        let order;
        try {
            order = await OrderModel.create({
                user_id: user._id,
                items: lines.map(toOrderItem),
                total,
                discount,
                payment_method: body.payment_method,
                payment_proof: paymentProof,
                status: 'pending',
            });
        } catch (error) {
            await deleteCapture(paymentProof);
            throw error;
        }

        notifyOrder(user, order);
        void logUserActivity(req, user, {
            action: ACTIVITY_ACTIONS.ORDER_CREATED,
            target_type: 'order',
            target_id: order._id,
            metadata: { total, items_count: order.items.length, order_status: order.status },
        });

        return serializeOrder(order.toObject());
    } finally {
        await del(lockKey);
    }
};

// Sin await: el pedido ya existe y un fallo de correo no puede devolver error (el usuario
// volveria a pagar creyendo que no se registro).
const notifyOrder = (user, order) => {
    void sendMail({
        to: user.email,
        subject: 'Recibimos tu pedido',
        template: 'api_order_received',
        data: { username: user.username, order_id: order._id, total: order.total.toFixed(2) },
    });
    if (settings.adminEmail) {
        void sendMail({
            to: settings.adminEmail,
            subject: 'Nuevo Pedido Recibido',
            template: 'api_order_review',
            data: {
                order_id: order._id,
                email: user.email,
                total: order.total.toFixed(2),
                payment_method: order.payment_method,
                items: order.items.map((item) => ({ name: item.name, areas: item.areas.map((area) => area.abrev).join(', ') })),
            },
        });
    }
};
