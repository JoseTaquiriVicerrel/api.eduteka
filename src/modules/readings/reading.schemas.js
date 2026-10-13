import { Type } from '@sinclair/typebox';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };

export const ListReadingsQuery = Type.Object({
    // Slug de una fila de GET /lecturas/areas ("sin-area" incluida).
    area: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    q: Type.Optional(Type.String({ maxLength: 200 })),
    ...paginationFields(),
}, strict);

export const ReadingAreasQuery = Type.Object({}, strict);

export const ReadingParams = Type.Object({ slug: Type.String({ minLength: 1, maxLength: 200 }) }, strict);
