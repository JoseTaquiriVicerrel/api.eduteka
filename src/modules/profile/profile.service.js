import bcrypt from 'bcrypt';
import AreaModel from '#Models/area_model.js';
import InstitutionModel from '#Models/institution_model.js';
import RefreshTokenModel from '#Models/refresh_token_model.js';
import UserModel from '#Models/user_model.js';
import UserQuestionsListModel from '#Models/user_questions_list_model.js';
import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { deleteAvatar, processAvatar, saveAvatar } from '#Libs/avatar_storage.js';
import { isAdmin } from '#Libs/capabilities.js';
import { newId, sha256 } from '#Libs/tokens.js';
import { AUTH_USER_FIELDS } from '#Middlewares/authenticate.js';
import { serializeUser } from '#Serializers/user.serializer.js';
import { assertNotLocked, clearFailures, recordFailure } from '#Modules/auth/login_throttle.js';
import { invalidateProgress } from '#Modules/progress/progress.cache.js';

// Perfil del propio usuario. Toda consulta filtra por el id del token, nunca por
// un id del cuerpo.

const PROFILE_FIELDS = { ...AUTH_USER_FIELDS, account_type_changed_at: 1 };

const loadProfile = async (userId) => {
    const user = await UserModel.findById(userId, PROFILE_FIELDS).lean().exec();
    if (!user) throw ApiError.unauthenticated();
    return user;
};

const serializeProfile = async (user) => {
    const institution = user.university
        ? await InstitutionModel.findById(user.university, { name: 1, abrev: 1 }).lean().exec()
        : null;

    return {
        ...serializeUser(user),
        institution: institution ? { id: institution._id, name: institution.name ?? null, abrev: institution.abrev ?? null } : null,
        account_type_change_available: !user.account_type_changed_at,
    };
};

export const getProfile = async (userId) => serializeProfile(await loadProfile(userId));

export const updateProfile = async (userId, body) => {
    const user = await loadProfile(userId);
    const set = {};
    const unset = {};

    if (body.username !== undefined) set.username = body.username;
    if (body.departament !== undefined) set.departament = body.departament;
    if (body.notification !== undefined) set.notification = body.notification;

    if (body.university !== undefined) {
        if (!(await InstitutionModel.exists({ _id: body.university, state: { $ne: false } }))) {
            throw ApiError.validation([{ field: 'university', message: 'La institución no existe.' }]);
        }
        set.university = body.university;
    }

    if (body.account_type !== undefined && body.account_type !== user.account_type) {
        // El tipo de cuenta define los permisos: no se cambia a voluntad.
        if (user.account_type_changed_at) {
            throw ApiError.forbidden('Solo puedes cambiar el tipo de cuenta una vez. Escríbenos si necesitas corregirlo.');
        }
        set.account_type = body.account_type;
        set.account_type_changed_at = new Date();
    }

    const effectiveType = set.account_type ?? user.account_type;
    if (body.teaching_area !== undefined) {
        if (effectiveType !== 'Profesor') {
            throw ApiError.validation([{ field: 'teaching_area', message: 'Solo las cuentas de profesor tienen un curso.' }]);
        }
        if (!(await AreaModel.exists({ _id: body.teaching_area }))) {
            throw ApiError.validation([{ field: 'teaching_area', message: 'El curso no existe.' }]);
        }
        set.teaching_area = body.teaching_area;
    }
    // Quien deja de ser profesor deja tambien el curso que enseñaba.
    if (effectiveType !== 'Profesor' && user.teaching_area) unset.teaching_area = 1;

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (Object.keys(update).length) await UserModel.updateOne({ _id: userId }, update).exec();

    return getProfile(userId);
};

// --- Contraseña y cuenta ----------------------------------------------------

const dummy = () => bcrypt.hash(newId(), settings.auth.bcryptRounds);

/**
 * Comprueba la contraseña actual. Comparte el limite de fallos del login. Un fallo
 * da 422 (no 401): un 401 haria que la app intente refrescar el token y reintente.
 */
const confirmPassword = async (userId, password, field) => {
    const user = await UserModel.findById(userId, { email: 1, rol: 1 }).select('+password').lean().exec();
    if (!user) throw ApiError.unauthenticated();

    await assertNotLocked(user.email);
    const matches = await bcrypt.compare(password, user.password ?? (await dummy()));

    if (!user.password || !matches) {
        await recordFailure(user.email);
        throw ApiError.validation([{ field, message: 'La contraseña no es correcta.' }]);
    }

    await clearFailures(user.email);
    return user;
};

const revokeSessions = async (userId, keepFamilyId = null) => {
    const filter = { user_id: userId, revoked_at: null };
    if (keepFamilyId) filter.family_id = { $ne: keepFamilyId };
    await RefreshTokenModel.updateMany(filter, { $set: { revoked_at: new Date() } }).exec();
};

export const changePassword = async (userId, { current_password: current, new_password: next, refresh_token: presented }) => {
    await confirmPassword(userId, current, 'current_password');

    if (next === current) {
        throw ApiError.validation([{ field: 'new_password', message: 'La nueva contraseña debe ser distinta de la actual.' }]);
    }

    await UserModel.updateOne({ _id: userId }, {
        $set: { password: await bcrypt.hash(next, settings.auth.bcryptRounds) },
        // Un restablecimiento pendiente deja de valer.
        $unset: { password_reset_jti: 1 },
    }).exec();

    // El cambio cierra las demas sesiones (si fue por un robo, dejarlas vivas lo haria inutil).
    let keepFamilyId = null;
    if (presented) {
        const current_session = await RefreshTokenModel
            .findOne({ token_hash: sha256(presented), user_id: userId, revoked_at: null }, { family_id: 1 })
            .lean()
            .exec();
        keepFamilyId = current_session?.family_id ?? null;
    }
    await revokeSessions(userId, keepFamilyId);

    return { changed: true, current_session_kept: Boolean(keepFamilyId) };
};

/**
 * Elimina la cuenta (requisito de Google Play). Se ANONIMIZA en vez de borrar el
 * documento: los pedidos, pagos e intentos referencian el user_id y deben
 * conservarse; sin datos personales ya no identifican a nadie.
 */
export const deleteAccount = async (userId, { password }) => {
    const user = await confirmPassword(userId, password, 'password');
    if (isAdmin(user)) throw ApiError.forbidden('Una cuenta de administrador no se puede eliminar desde la app.');

    const previous = await UserModel.findById(userId, { avatar: 1 }).lean().exec();

    await UserModel.updateOne({ _id: userId }, {
        $set: {
            state: false,
            email: `deleted+${userId}@deleted.invalid`,
            username: 'Usuario eliminado',
            notification: false,
            notification_subscription_renovation: false,
            notification_subscription_expiration: false,
        },
        $unset: {
            password: 1, name: 1, fullname: 1, dni: 1, document_number: 1, avatar: 1, university: 1,
            teaching_area: 1, departament: 1, token_verify: 1, token_verify_expires: 1, token_verify_attempts: 1,
            token_recovery_verify: 1, token_recovery_expires: 1, token_recovery_attempts: 1, password_reset_jti: 1,
        },
    }).exec();

    await revokeSessions(userId);
    // Las listas privadas se borran; las publicadas siguen siendo de la comunidad, sin autor.
    await UserQuestionsListModel.deleteMany({ user: userId, public: { $ne: true } }).exec();
    await UserQuestionsListModel.updateMany({ user: userId, public: true }, { $unset: { user: 1 } }).exec();
    await deleteAvatar(previous?.avatar);
    await invalidateProgress(userId);

    return { deleted: true };
};

// --- Avatar -----------------------------------------------------------------

export const updateAvatar = async (userId, buffer) => {
    const jpeg = await processAvatar(buffer);
    const previous = await UserModel.findById(userId, { avatar: 1 }).lean().exec();
    if (!previous) throw ApiError.unauthenticated();

    const avatar = await saveAvatar(userId, jpeg);
    await UserModel.updateOne({ _id: userId }, { $set: { avatar } }).exec();
    await deleteAvatar(previous.avatar);

    return getProfile(userId);
};
