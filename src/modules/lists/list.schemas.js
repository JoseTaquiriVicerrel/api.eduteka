import { Type } from '@sinclair/typebox';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 64 });
// Hasta 50 preguntas por lista (el tope real depende del plan; ver list.service.js).
const QuestionIds = Type.Array(Id, { maxItems: 50, uniqueItems: true });

const Name = Type.String({ minLength: 1, maxLength: 120, pattern: '\\S' });
const Description = Type.String({ maxLength: 500 });

export const ListsQuery = Type.Object({
    // Si llega, cada lista indica si ya contiene esa pregunta (para "agregar a una lista").
    question_id: Type.Optional(Id),
    ...paginationFields(),
}, strict);

export const ListParams = Type.Object({ id: Id }, strict);
export const ListQuestionParams = Type.Object({ id: Id, question_id: Id }, strict);

export const CreateListBody = Type.Object({
    name: Name,
    description: Type.Optional(Description),
    question_ids: Type.Optional(QuestionIds),
}, strict);

export const UpdateListBody = Type.Object({
    name: Type.Optional(Name),
    description: Type.Optional(Description),
    public: Type.Optional(Type.Boolean()),
    // Reemplaza el contenido y el orden de la lista (arrastrar y soltar).
    questions: Type.Optional(QuestionIds),
}, { ...strict, minProperties: 1 });

export const AddQuestionBody = Type.Object({ question_id: Id }, strict);

// `include_answers` añade la clave de respuestas al final del PDF (solo suscriptores y docentes).
export const PdfQuery = Type.Object({ include_answers: Type.Optional(Type.Boolean()) }, strict);
