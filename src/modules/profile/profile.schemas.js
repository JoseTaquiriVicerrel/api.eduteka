import { Type } from '@sinclair/typebox';
import { paginationFields } from '#Libs/paginate.js';

const strict = { additionalProperties: false };

export const UpdateProfileBody = Type.Object({
    username: Type.Optional(Type.String({ minLength: 3, maxLength: 50, pattern: '^\\S.*\\S$' })),
    departament: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    university: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    teaching_area: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    notification: Type.Optional(Type.Boolean()),
    // Un unico cambio de tipo de cuenta desde la app (igual que la web); despues, solo un administrador.
    account_type: Type.Optional(Type.Union([Type.Literal('Estudiante'), Type.Literal('Profesor')])),
}, { ...strict, minProperties: 1 });

export const ChangePasswordBody = Type.Object({
    current_password: Type.String({ minLength: 1, maxLength: 128 }),
    new_password: Type.String({ minLength: 8, maxLength: 15 }),
    // Opcional: el refresh token de ESTE dispositivo. Si llega, esa sesion se conserva
    // y se cierran las demas; si no, se cierran todas y hay que volver a iniciar sesion.
    refresh_token: Type.Optional(Type.String({ minLength: 20, maxLength: 4096 })),
}, strict);

export const DeleteAccountBody = Type.Object({
    password: Type.String({ minLength: 1, maxLength: 128 }),
}, strict);

export const AttemptsQuery = Type.Object({
    type: Type.Optional(Type.Union([Type.Literal('practica'), Type.Literal('simulacro')])),
    ...paginationFields(),
}, strict);
