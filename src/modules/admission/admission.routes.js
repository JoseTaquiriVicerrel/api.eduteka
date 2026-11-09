import { Router } from 'express';
import validate from '#Middlewares/validate.js';
import * as controller from './admission.controller.js';
import { CalendarQuery } from './admission.schemas.js';

const router = Router();

// Publico, como /calendario-admision de la web. El .ics lo pide la web para reenviarlo al usuario.
router.get('/calendario', validate(CalendarQuery, 'query'), controller.calendar);
router.get('/calendario.ics', validate(CalendarQuery, 'query'), controller.ics);

export default router;
