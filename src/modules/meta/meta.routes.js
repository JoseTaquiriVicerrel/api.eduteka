import { Router } from 'express';
import { getConfig, getHealth } from './meta.controller.js';

const router = Router();

router.get('/config', getConfig);
router.get('/health', getHealth);

export default router;
