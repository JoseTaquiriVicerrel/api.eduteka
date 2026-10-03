import { Type } from '@sinclair/typebox';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };

// Mismo tope que el carrito de la web (#Controllers/cart.controllers.js).
export const MAX_CART_ITEMS = 30;

// Metodos con comprobante manual. 'tarjeta' existe en el schema de Order pero no tiene
// comprobante que subir: no se acepta.
export const ORDER_PAYMENT_METHODS = ['yape', 'plin', 'transferencia'];

export const ListProductsQuery = Type.Object({
    type: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    q: Type.Optional(Type.String({ maxLength: 200 })),
    ...paginationFields(),
}, strict);

export const SlugParams = Type.Object({ slug: Type.String({ minLength: 1, maxLength: 200 }) }, strict);

const CartItem = Type.Object({
    product_id: Type.String({ minLength: 1, maxLength: 64 }),
    // Claves de area (`abrev` de /productos). Ignoradas en productos de area unica.
    areas: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 30 }), { maxItems: 20 })),
}, strict);

const CartItems = Type.Array(CartItem, { minItems: 1, maxItems: MAX_CART_ITEMS });

export const ResolveCartBody = Type.Object({ items: CartItems }, strict);

// multipart: `items` llega como texto JSON y se convierte antes de validar
// (parseJsonFields). `expected_total` tambien llega como texto.
export const CheckoutBody = Type.Object({
    items: CartItems,
    payment_method: Type.Union(ORDER_PAYMENT_METHODS.map((method) => Type.Literal(method))),
    // Total que el usuario vio (y pago). Si el precio cambio entretanto, 409 en vez de
    // registrar un pedido cuyo importe no coincide con el comprobante.
    expected_total: Type.Optional(Type.Number({ minimum: 0 })),
}, strict);

export const ListOrdersQuery = Type.Object({
    status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('verified'), Type.Literal('rejected')])),
    ...paginationFields(),
}, strict);

export const OrderParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }, strict);
