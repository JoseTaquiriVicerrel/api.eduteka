import { Type } from '@sinclair/typebox';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 64 });

export const ListSimulacraQuery = Type.Object({
    institution: Type.Optional(Id),
    q: Type.Optional(Type.String({ maxLength: 200 })),
    status: Type.Optional(Type.Union([Type.Literal('upcoming'), Type.Literal('live'), Type.Literal('finished')])),
    ...paginationFields(),
}, strict);

export const SlugParams = Type.Object({ slug: Type.String({ minLength: 1, maxLength: 200 }) }, strict);

export const AttemptParams = Type.Object({ attempt_id: Id }, strict);

// Tambien llega como campos de un multipart (todo texto): por eso `area`/`career` son strings.
export const EnrollBody = Type.Object({
    fullname: Type.String({ minLength: 3, maxLength: 150, pattern: '^\\S.*\\S$' }),
    // Obsoleto: el DNI es un dato sensible y ya no se pide. Se tolera solo para que las apps
    // antiguas (que aun lo envian) no reciban 422; se descarta sin validarlo ni guardarlo.
    dni: Type.Optional(Type.String({ maxLength: 32 })),
    area: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    career: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
}, strict);

// { id_de_pregunta: "A" | null }. `null` = quitar la respuesta.
const AnswersMap = Type.Record(
    Type.String({ minLength: 1, maxLength: 64 }),
    Type.Union([Type.String({ pattern: '^[A-Za-z0-9]{1,3}$' }), Type.Null()]),
    { maxProperties: 300 },
);

export const SaveAnswersBody = Type.Object({
    answers: AnswersMap,
    // Si llega, debe ser el del intento vigente: una pestaña o app vieja no pisa el intento nuevo.
    attempt_number: Type.Optional(Type.Integer({ minimum: 1 })),
}, { ...strict });

export const FinalizeBody = Type.Object({
    answers: Type.Optional(AnswersMap),
    attempt_number: Type.Optional(Type.Integer({ minimum: 1 })),
}, strict);

export const SolucionarioQuery = Type.Object({
    // Solo para docentes (sin intento propio): el area del simulacro que quieren revisar.
    area: Type.Optional(Id),
}, strict);
