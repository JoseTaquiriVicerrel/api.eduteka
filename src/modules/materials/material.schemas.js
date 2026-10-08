import { Type } from '@sinclair/typebox';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };

export const ListMaterialsQuery = Type.Object({ ...paginationFields() }, strict);

export const MaterialParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }, strict);
