import { Type } from '@sinclair/typebox';

const strict = { additionalProperties: false };

export const CalendarQuery = Type.Object({
    // Id de una institucion con fechas; una que no figure se ignora (como el monolito).
    institucion: Type.Optional(Type.String({ maxLength: 64 })),
    // Tipos separados por coma ("examen,resultados"); los desconocidos se ignoran.
    tipo: Type.Optional(Type.String({ maxLength: 120 })),
}, strict);
