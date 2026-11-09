import { asyncHandler } from '#Libs/async_handler.js';
import { ok } from '#Libs/envelope.js';
import * as admission from './admission.service.js';

export const calendar = asyncHandler(async (req, res) => ok(res, await admission.getCalendar(req.query)));

export const ics = asyncHandler(async (req, res) => {
    const { content, filename } = await admission.getCalendarIcs(req.query);
    res.set({
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'public, max-age=900',
    });
    return res.send(content);
});
