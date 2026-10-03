import { Router } from 'express';
import { ApiError } from '#Libs/api_error.js';
import { avatarPath } from '#Libs/avatar_storage.js';
import { mathFilePath } from '#Libs/math_store.js';

const router = Router();

// SVG de formulas LaTeX (docs/api-latex-svg-plan.md). Publicos: no son datos de usuario.
// El nombre es el hash del contenido, asi que cada archivo es inmutable y se cachea un año.
// No se genera nada aqui: la ruta no tiene el TeX; los SVG los crea el serializador al
// responder con ?math=svg. Si el archivo no existe, 404 y la app cae a KaTeX.
router.get('/math/:file', (req, res, next) => {
    const file = mathFilePath(req.params.file);
    if (!file) return next(ApiError.notFound());

    // Las cabeceras viajan en `headers` para que solo las lleve la respuesta con el archivo:
    // un 404 es JSON y no debe salir etiquetado como SVG.
    const headers = {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Un SVG servido como documento no debe poder ejecutar ni cargar nada.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        // helmet pone same-origin; estas imagenes son publicas y las puede pintar cualquier cliente.
        'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    return res.sendFile(file, { cacheControl: false, dotfiles: 'deny', headers }, (error) => {
        if (error && !res.headersSent) next(ApiError.notFound());
    });
});

// Avatares subidos por la API. Publicos (se ven en perfiles y rankings); el nombre
// lleva un sufijo aleatorio, asi que cada version es inmutable y se cachea un año.
router.get('/avatars/:file', (req, res, next) => {
    const file = avatarPath(req.params.file);
    if (!file) return next(ApiError.notFound());

    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(file, { cacheControl: false, dotfiles: 'deny' }, (error) => {
        if (error && !res.headersSent) next(ApiError.notFound());
    });
});

export default router;
