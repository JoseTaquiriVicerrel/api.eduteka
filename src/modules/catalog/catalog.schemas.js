import { Type } from '@sinclair/typebox';

const strict = { additionalProperties: false };

export const AreasQuery = Type.Object({
    institution: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    with_resolution: Type.Optional(Type.Boolean()),
}, strict);
