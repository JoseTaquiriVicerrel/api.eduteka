import { Type } from '@sinclair/typebox';

// Esquemas de entrada de /auth. Todos con additionalProperties:false: un campo
// que el servidor no espera es un error, no algo que se ignora en silencio.

const Email = Type.String({ format: 'email', maxLength: 254 });
const Code = Type.String({ pattern: '^[0-9]{6}$' });
// 8-15 caracteres (especificacion §4). bcrypt solo lee los primeros 72 bytes.
const NewPassword = Type.String({ minLength: 8, maxLength: 15 });
const Token = Type.String({ minLength: 20, maxLength: 4096 });

const strict = { additionalProperties: false };

export const RegisterBody = Type.Object({
    email: Email,
    password: NewPassword,
    // Sin espacios al inicio ni al final; 3-50 caracteres.
    username: Type.String({ minLength: 3, maxLength: 50, pattern: '^\\S.*\\S$' }),
    departament: Type.String({ minLength: 1, maxLength: 60 }),
    account_type: Type.Union([Type.Literal('Estudiante'), Type.Literal('Profesor')]),
    university: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    teaching_area: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    edkNotification: Type.Optional(Type.Boolean()),
}, strict);

export const ResendCodeBody = Type.Object({ email: Email }, strict);

export const VerifyCodeBody = Type.Object({ email: Email, code: Code }, strict);

export const LoginBody = Type.Object({
    email: Email,
    // Sin el rango 8-15: las cuentas antiguas pueden tener otra longitud.
    password: Type.String({ minLength: 1, maxLength: 128 }),
}, strict);

export const RefreshBody = Type.Object({ refresh_token: Token }, strict);

export const LogoutBody = Type.Object({ refresh_token: Token }, strict);

export const RecoverBody = Type.Object({ email: Email }, strict);

export const VerifyRecoveryCodeBody = Type.Object({ email: Email, code: Code }, strict);

export const ResetPasswordBody = Type.Object({ reset_token: Token, password: NewPassword }, strict);
