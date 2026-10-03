import { Type } from '@sinclair/typebox';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 64 });

export const ListExamsQuery = Type.Object({
    institution: Type.Optional(Id),
    modality: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    year: Type.Optional(Type.Integer({ minimum: 1900, maximum: 2100 })),
    // Area del catalogo, por id o slug.
    area: Type.Optional(Id),
    q: Type.Optional(Type.String({ maxLength: 200 })),
    ...paginationFields(),
}, strict);

export const ExamSlugParams = Type.Object({ slug: Type.String({ minLength: 1, maxLength: 200 }) }, strict);

// `area` del detalle es el CODIGO del cuadernillo dentro del examen ("A", "B", "I"...).
export const ExamDetailQuery = Type.Object({
    area: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
}, strict);

export const ExamIdParams = Type.Object({ id: Id }, strict);

export const FavoriteBody = Type.Object({
    // Con `favorite` se fija el estado (idempotente: reenviar no lo cambia); sin el, se alterna.
    favorite: Type.Optional(Type.Boolean()),
}, strict);

export const FavoritesQuery = Type.Object({ ...paginationFields() }, strict);
