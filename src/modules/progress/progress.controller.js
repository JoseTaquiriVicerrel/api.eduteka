import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';
import { getProgress } from './progress.service.js';

// La web (req.client, ver middlewares/client.js) no usa el cache: como /mi-progreso del monolito,
// "Hoy" se mueve en cuanto responde, aunque la respuesta haya entrado por el monolito.
export const dashboard = asyncHandler(async (req, res) =>
    ok(res, await getProgress(req.user._id, new Date(), { fresh: req.client === 'web' })));
