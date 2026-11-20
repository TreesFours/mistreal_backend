import { Router, Request, Response } from 'express';
import { LiveCamService } from '../services/liveCamService';
import logger from '../utils/logger';

const router = Router();

router.get('/live-cams', async (req: Request, res: Response) => {
    try {
        const query = req.query.q as string | undefined;
        const protocol = req.query.protocol as string | undefined;
        const type = req.query.type as string | undefined;

        const cams = await LiveCamService.getLiveCams(query, protocol, type);
        res.json({ success: true, cams });
    } catch (e: any) {
        logger.error(`❌ GET /api/live-cams error: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

export default router;
