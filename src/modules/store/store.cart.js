import { buildSelectableAreas } from '#Libs/product_areas.js';
import { cartTotals, itemDiscount, itemSubtotal, itemTotal } from '#Libs/store_pricing.js';
import { absoluteUrl } from '#Libs/urls.js';

// Carrito -> lineas con precio. El carrito vive en el cliente: del cliente solo se
// acepta QUE producto y QUE areas; el precio, el multiplicador (numero de areas) y el
// descuento los pone el servidor con las mismas reglas que la web
// (#Libs/store_pricing.js y #Libs/product_areas.js son copias del monolito).
//
// Dos modos:
//  - resolver (lenient): normaliza un carrito viejo. Descarta repetidos, informa de los
//    productos que ya no se venden y cambia areas invalidas por la preseleccionada. El
//    cliente reemplaza su carrito por el resultado.
//  - checkout (strict): cualquier diferencia es un error. Nunca se cobra algo distinto
//    de lo que el usuario eligio y vio.

export const CART_PRODUCT_PROJECTION = Object.freeze({
    name: 1, slug: 1, price: 1, type: 1, type_file: 1, unique: 1, areas: 1, poster: 1,
});

const publicArea = ({ abrev, label, title, description }) => ({ abrev, label, title, description });

/**
 * @param {Array<{product_id: string, areas?: string[]}>} requested
 * @param {Map<string, object>} productsById productos a la venta (`state: true`)
 * @returns {{ lines: object[], unavailable: string[], problems: object[] }}
 *   `problems` (detalles de validacion) solo se llena en modo estricto.
 */
export const buildCart = (requested, productsById, { strict = false } = {}) => {
    const lines = [];
    const unavailable = [];
    const problems = [];
    const seen = new Set();

    requested.forEach((item, index) => {
        const field = `items.${index}`;
        const productId = item.product_id;

        if (seen.has(productId)) {
            if (strict) problems.push({ field: `${field}.product_id`, message: 'El producto está repetido en el carrito.' });
            return;
        }
        seen.add(productId);

        const product = productsById.get(productId);
        if (!product) {
            unavailable.push(productId);
            return;
        }

        const selectable = buildSelectableAreas(product);
        let areas;

        // Producto de area unica (o con una sola area a la venta): se compra completo.
        if (product.unique || selectable.length === 1) {
            areas = selectable;
        } else {
            const wanted = item.areas ?? [];
            const matches = (entry, key) => entry.abrev === key || entry.label === key;
            areas = selectable.filter((entry) => wanted.some((key) => matches(entry, key)));

            if (strict) {
                const invalid = wanted.filter((key) => !selectable.some((entry) => matches(entry, key)));
                if (invalid.length > 0) {
                    problems.push({ field: `${field}.areas`, message: `Áreas no disponibles para "${product.name}": ${invalid.join(', ')}.` });
                } else if (areas.length === 0) {
                    problems.push({ field: `${field}.areas`, message: `Selecciona al menos un área para "${product.name}".` });
                }
            }
            if (areas.length === 0) areas = selectable.filter((entry) => entry.checked);
        }

        const priced = { price: Number(product.price) || 0, type: product.type, areas };
        lines.push({
            product,
            price: priced.price,
            areas,
            selectable,
            subtotal: itemSubtotal(priced),
            discount: itemDiscount(priced),
            total: itemTotal(priced),
        });
    });

    return { lines, unavailable, problems };
};

export const totalsOf = (lines) => cartTotals(lines.map(({ price, product, areas }) => ({ price, type: product.type, areas })));

/** Item tal como se guarda en `Order.items` (misma forma que el checkout de la web). */
export const toOrderItem = ({ product, price, areas }) => ({
    product_id: product._id,
    name: product.name,
    price, // por area
    quantity: 1, // el numero de areas es el multiplicador, no la cantidad
    areas: areas.map(({ abrev, title, description }) => ({ abrev, title, description })),
});

export const serializeCartLine = ({ product, price, areas, selectable, subtotal, discount, total }) => ({
    product: {
        id: product._id,
        name: product.name ?? null,
        slug: product.slug ?? null,
        type: product.type ?? null,
        poster: product.poster ? absoluteUrl(product.poster) : null,
        unique: Boolean(product.unique),
    },
    unit_price: price,
    areas: areas.map(publicArea),
    selectable_areas: selectable.map(publicArea),
    subtotal,
    discount,
    total,
});
