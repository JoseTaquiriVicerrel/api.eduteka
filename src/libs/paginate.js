import { Type } from '@sinclair/typebox';

// Paginacion por pagina (especificacion §3.3): ?page=1&limit=20, maximo 50.
// `meta` = { page, limit, total, has_more }. El orden estable lo pone cada
// consulta (created_at desc, _id).

export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;
// Un `skip` enorme obliga a Mongo a recorrer todo lo anterior; nadie navega mas alla.
export const MAX_PAGE = 1000;

/** Campos `page` y `limit` para esparcir dentro del esquema de un query. */
export const paginationFields = () => ({
    page: Type.Integer({ minimum: 1, maximum: MAX_PAGE, default: 1 }),
    limit: Type.Integer({ minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT }),
});

export const skipOf = ({ page, limit }) => (page - 1) * limit;

export const pageMeta = ({ page, limit, total }) => ({
    page,
    limit,
    total,
    has_more: page * limit < total,
});
