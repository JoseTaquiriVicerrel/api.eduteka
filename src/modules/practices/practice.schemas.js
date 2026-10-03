import { Type } from '@sinclair/typebox';
import { MAX_QUESTIONS } from '#Modules/practices/practice.limits.js';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 64 });

// { id_de_pregunta: "A" | null }. `null` = la salto: es informacion valida y
// distinta de no haberla incluido.
const AnswersMap = Type.Record(
    Type.String({ minLength: 1, maxLength: 64 }),
    Type.Union([Type.String({ pattern: '^[A-Za-z0-9]{1,3}$' }), Type.Null()]),
    { maxProperties: MAX_QUESTIONS },
);

const Time = Type.Integer({ minimum: 0, maximum: 86_400, default: 0 });

export const AreaPracticeQuery = Type.Object({
    area: Id,
    topic: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    difficulty: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    institution: Type.Optional(Id),
    count: Type.Integer({ minimum: 1, maximum: MAX_QUESTIONS, default: 10 }),
    with_resolution: Type.Optional(Type.Boolean()),
}, strict);

export const FinalizeAreaBody = Type.Object({
    area: Id,
    topic: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
    question_ids: Type.Array(Id, { minItems: 1, maxItems: MAX_QUESTIONS, uniqueItems: true }),
    answers: AnswersMap,
    time: Time,
}, strict);

export const ListPracticesQuery = Type.Object({
    area: Type.Optional(Id),
    q: Type.Optional(Type.String({ maxLength: 200 })),
    ...paginationFields(),
}, strict);

export const PracticeParams = Type.Object({ slug: Type.String({ minLength: 1, maxLength: 200 }) }, strict);

export const FinalizePracticeBody = Type.Object({ answers: AnswersMap, time: Time }, strict);
