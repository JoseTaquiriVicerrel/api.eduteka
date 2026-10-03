import { Type } from '@sinclair/typebox';

const strict = { additionalProperties: false };

export const SlugParams = Type.Object({ slug: Type.String({ minLength: 1, maxLength: 200 }) }, strict);

// multipart con el comprobante en `payment_proof` (o `payment_capture`, el nombre de la web).
export const SubscribeBody = Type.Object({
    payment_method: Type.Optional(Type.Union([Type.Literal('yape'), Type.Literal('plin')])),
    // Obligatoria en un plan restringido a una institucion (salvo que se renueve uno que ya
    // la tiene). En los demas es opcional y se guarda como universidad del usuario.
    institution_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, strict);
