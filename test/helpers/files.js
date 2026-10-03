import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Arbol de archivos de prueba para las descargas:
//   <base>/root/storage/...   -> FILES_ROOT_DIR (lo que la API puede servir)
//   <base>/outside/secret.pdf -> fuera de la raiz: jamas debe poder leerse
export function makeFilesTree() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eduteka-files-'));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, 'storage', 'examenes'), { recursive: true });
    fs.mkdirSync(path.join(root, 'storage', 'productos'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    // Contenido reconocible byte a byte (para probar Range).
    const content = (label, size) => Buffer.concat([Buffer.from(`%PDF-1.4 ${label}\n`), Buffer.alloc(size, label.charCodeAt(0))]);
    const files = {
        'storage/examenes/e1-a.pdf': content('E1A', 5000),
        'storage/productos/guia.pdf': content('GUIA', 3000),
        'storage/productos/examen-A.pdf': content('PA', 2000),
        'storage/productos/examen-B.pdf': content('PB', 2000),
        'storage/productos/unico.pdf': content('UNICO', 1500),
    };
    for (const [relative, buffer] of Object.entries(files)) fs.writeFileSync(path.join(root, relative), buffer);
    fs.writeFileSync(path.join(outside, 'secret.pdf'), 'TOP SECRET');

    return { base, root, files, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** Productos, pedidos y examenes con archivos. `owner` es un usuario ya creado. */
export async function seedDownloads(ctx, owner, other) {
    const { db } = ctx.mongoose.connection;

    await db.collection('products').insertMany([
        { _id: 'prod-guia', name: 'Guía de estudio', type: 'Material', unique: false, state: true, files: [{ name: 'Guia', path: 'storage/productos/guia.pdf', area: null }] },
        {
            _id: 'prod-examen', name: 'Examen UNMSM', type: 'Examen', unique: false, state: true, type_file: 'PDF',
            files: [
                { name: 'Examen A', path: 'storage/productos/examen-A.pdf', area: 'A' },
                { name: 'Examen B', path: 'storage/productos/examen-B.pdf', area: 'B' },
            ],
        },
        { _id: 'prod-unico', name: 'Examen único', type: 'Examen', unique: true, state: true, files: [{ name: 'Unico', path: 'storage/productos/unico.pdf', area: 'I' }] },
        {
            _id: 'prod-roto', name: 'Producto con archivos rotos', type: 'Material', unique: false, state: true,
            files: [
                { name: 'Falta', path: 'storage/productos/no-existe.pdf' },
                { name: 'Escape', path: '../outside/secret.pdf' },
            ],
        },
    ]);

    const item = (productId, name, areas = []) => ({ product_id: productId, name, price: 10, quantity: 1, areas });
    await db.collection('orders').insertMany([
        {
            _id: 'o-verified', user_id: owner.session.user.id, status: 'verified', total: 20, created_at: new Date(Date.UTC(2026, 0, 3)),
            items: [item('prod-guia', 'Guía de estudio'), item('prod-examen', 'Examen UNMSM', [{ abrev: 'A', title: 'Área A' }]), item('prod-roto', 'Roto')],
        },
        { _id: 'o-pending', user_id: owner.session.user.id, status: 'pending', total: 10, created_at: new Date(Date.UTC(2026, 0, 2)), items: [item('prod-unico', 'Examen único')] },
        { _id: 'o-rejected', user_id: owner.session.user.id, status: 'rejected', total: 10, created_at: new Date(Date.UTC(2026, 0, 1)), items: [item('prod-guia', 'Guía de estudio')] },
        { _id: 'o-other', user_id: other.session.user.id, status: 'verified', total: 10, created_at: new Date(), items: [item('prod-guia', 'Guía de estudio')] },
    ]);

    // Examenes con archivo: A existe; B intenta salir de la raiz; el de e2 no existe en disco.
    await db.collection('exams').updateOne({ _id: 'e1' }, { $set: {
        files: {
            A: { path: 'storage/examenes/e1-a.pdf', title: 'Cuadernillo A' },
            B: { path: '../outside/secret.pdf', title: 'Cuadernillo B' },
        },
    } });
    await db.collection('exams').updateOne({ _id: 'e2' }, { $set: { files: { I: { path: 'storage/examenes/falta.pdf', title: 'Único' } } } });
}
