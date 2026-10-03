import { Type } from '@sinclair/typebox';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 64 });

export const ListQuestionsQuery = Type.Object({
    area: Type.Optional(Id),
    topic: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    difficulty: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    institution: Type.Optional(Id),
    q: Type.Optional(Type.String({ maxLength: 200 })),
    ...paginationFields(),
}, strict);

export const TopicsQuery = Type.Object({
    area: Id,
    institution: Type.Optional(Id),
    with_resolution: Type.Optional(Type.Boolean()),
}, strict);

export const QuestionParams = Type.Object({ id: Id }, strict);

export const AnswerBody = Type.Object({
    // La letra de la alternativa ("A".."E"). Se compara sin distinguir mayusculas.
    selected: Type.String({ minLength: 1, maxLength: 3, pattern: '^[A-Za-z0-9]+$' }),
}, strict);

export const ReportBody = Type.Object({
    type: Type.Union([Type.Literal('Pregunta'), Type.Literal('Opción'), Type.Literal('Respuesta')]),
    // Debe tener algun caracter visible; el servidor recorta los espacios.
    description: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
}, strict);
