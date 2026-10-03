import { Type } from '@sinclair/typebox';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };

export const ListDownloadsQuery = Type.Object({
    // order = lo comprado; exam = los examenes que da la suscripcion.
    source: Type.Optional(Type.Union([Type.Literal('order'), Type.Literal('exam')])),
    institution: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    modality: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    q: Type.Optional(Type.String({ maxLength: 200 })),
    ...paginationFields(),
}, strict);

export const OrderFileParams = Type.Object({
    order_id: Type.String({ minLength: 1, maxLength: 64 }),
    product_id: Type.String({ minLength: 1, maxLength: 64 }),
    file: Type.String({ minLength: 1, maxLength: 300 }),
}, strict);

export const LinkParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 600 }) }, strict);

export const RedeemQuery = Type.Object({ token: Type.String({ minLength: 20, maxLength: 4096 }) }, strict);

export const ExamPdfParams = Type.Object({ slug: Type.String({ minLength: 1, maxLength: 200 }) }, strict);
export const ExamPdfQuery = Type.Object({ area: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })) }, strict);
