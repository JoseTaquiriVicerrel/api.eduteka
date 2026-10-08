import express from 'express';
import appVersion from '#Middlewares/app_version.js';
import maintenance from '#Middlewares/maintenance.js';
import { rateLimit } from '#Middlewares/rate_limit.js';
import authRoutes from './auth/auth.routes.js';
import catalogRoutes from './catalog/catalog.routes.js';
import downloadRoutes from './downloads/download.routes.js';
import examRoutes from './exams/exam.routes.js';
import questionRoutes from './questions/question.routes.js';
import { areaRouter, listRouter } from './practices/practice.routes.js';
import metaRoutes from './meta/meta.routes.js';
import listRoutes from './lists/list.routes.js';
import mediaRoutes from './media/media.routes.js';
import mathResponse from '#Middlewares/math_response.js';
import profileRoutes from './profile/profile.routes.js';
import simulacrumRoutes from './simulacra/simulacrum.routes.js';
import { orderRouter, productRouter, storeRouter } from './store/store.routes.js';
import subscriptionRoutes from './subscriptions/subscription.routes.js';
import materialRoutes from './materials/material.routes.js';
import teacherRoutes from './teacher/teacher.routes.js';
import progressRoutes from './progress/progress.routes.js';

// Router de /api/v1. El orden importa: primero lo barato (limites, version,
// mantenimiento) y solo despues se lee el cuerpo de la peticion.
export function buildV1Router() {
    const router = express.Router();

    // Los SVG de formulas quedan fuera del limite: una pantalla con muchas preguntas pide
    // decenas de imagenes de golpe y agotaria los 120/min de la IP (y de toda una red NAT).
    // Son estaticos e inmutables y el nombre es un hash de 128 bits (no se pueden enumerar).
    router.use(rateLimit('global', { skip: (req) => req.path === '/health' || req.path.startsWith('/media/math/') }));
    router.use(appVersion);
    router.use(maintenance);
    router.use(express.json({ limit: '100kb' }));

    router.use(metaRoutes);
    router.use('/auth', authRoutes);
    router.use(catalogRoutes);
    router.use('/preguntas', mathResponse, questionRoutes);
    router.use('/examenes', mathResponse, examRoutes);
    router.use('/descargas', downloadRoutes);
    router.use('/simulacros', mathResponse, simulacrumRoutes);
    router.use('/practicas-area', mathResponse, areaRouter);
    router.use('/practicas', mathResponse, listRouter);
    router.use('/perfil', profileRoutes);
    router.use('/progreso', progressRoutes);
    router.use('/mis-listas', mathResponse, listRoutes);
    router.use('/media', mediaRoutes);
    router.use('/productos', productRouter);
    router.use('/tienda', storeRouter);
    router.use('/pedidos', orderRouter);
    router.use('/suscripciones', subscriptionRoutes);
    router.use('/mis-materiales', materialRoutes);
    router.use('/docente', teacherRoutes);

    return router;
}
