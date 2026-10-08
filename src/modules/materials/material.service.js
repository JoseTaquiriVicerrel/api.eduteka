import MaterialModel from '#Models/material_model.js';
import { settings } from '#Config/settings.js';
import { ApiError } from '#Libs/api_error.js';
import { skipOf } from '#Libs/paginate.js';
import { limitsFor } from '#Libs/plan_limits.js';
import { resolveStoredFile } from '#Modules/downloads/download.files.js';
import { GENERATED_MATERIAL } from '#Modules/teacher/teacher.service.js';

// "Mis materiales": los materiales que el docente genero en la web, para verlos y descargarlos desde la app.
// Solo el dueno (`created_by`): el de otro usuario responde 404, como si no existiera. Se muestran todos, tambien
// los desactivados (`active: false`); activar o desactivar se hace solo en la web.

const publicUrl = (route) => `${settings.app.apiUrl ?? ''}/api/v1${route}`;

const extensionOf = (storedPath) => {
    const extension = String(storedPath ?? '').split('.').pop()?.toLowerCase();
    return extension && extension.length <= 5 ? extension : null;
};

const serialize = async (material) => {
    const stored = await resolveStoredFile(material.file_path);
    return {
        id: material._id,
        title: material.title ?? null,
        type_file: extensionOf(material.file_path),
        active: material.state === true,
        size: stored?.size ?? null,
        // El archivo puede faltar en el servidor aunque el material exista.
        available: Boolean(stored),
        created_at: material.created_at ? new Date(material.created_at).toISOString() : null,
        download_url: stored ? publicUrl(`/mis-materiales/${encodeURIComponent(material._id)}/descargar`) : null,
    };
};

export const listMaterials = async ({ user, page, limit }) => {
    const filter = { created_by: user._id, ...GENERATED_MATERIAL };
    const [items, total, active] = await Promise.all([
        MaterialModel.find(filter, { title: 1, state: 1, file_path: 1, created_at: 1 })
            .sort({ created_at: -1, _id: 1 })
            .skip(skipOf({ page, limit }))
            .limit(limit)
            .lean()
            .exec(),
        MaterialModel.countDocuments(filter).exec(),
        MaterialModel.countDocuments({ ...filter, state: true }).exec(),
    ]);

    const limitMaterials = limitsFor(user).materials;
    return {
        items: await Promise.all(items.map(serialize)),
        total,
        // Los desactivados cuentan para el uso total; `active` va aparte para quien quiera distinguirlos.
        quota: { limit: limitMaterials, used: total, active, remaining: Math.max(0, limitMaterials - total) },
    };
};

/** El material del propio usuario y su archivo, o 404. */
export const resolveMaterialFile = async ({ user, id }) => {
    const material = await MaterialModel.findOne({ _id: id, created_by: user._id, ...GENERATED_MATERIAL }, { title: 1, file_path: 1 }).lean().exec();
    if (!material) throw ApiError.notFound('No encontramos ese material.');

    const stored = await resolveStoredFile(material.file_path);
    if (!stored) throw ApiError.notFound('El archivo ya no esta disponible.');

    const base = (material.title ?? 'material').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'material';
    const name = `${base}${stored.extension ? `.${stored.extension}` : ''}`;
    return {
        stored,
        downloadName: name,
        audit: {
            source: 'material',
            resource_type: 'material',
            resource_id: material._id,
            resource_name: material.title,
            file_name: name,
            file_path: material.file_path,
        },
    };
};
