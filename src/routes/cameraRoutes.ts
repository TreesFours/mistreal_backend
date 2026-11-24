import { Router, Request, Response } from 'express';
import { CameraProfile } from '../models/CameraProfile';
import logger from '../utils/logger';

/**
 * Live-cam discovery feed — manual admin review queue before any submitted
 * camera link goes public. Mounted at /api/cameras.
 */
const router = Router();

const YOUTUBE_URL_PATTERN = /^https?:\/\/(www\.)?(youtube\.com\/|youtu\.be\/)/i;
const HLS_URL_PATTERN = /^https?:\/\/.+\.m3u8(\?.*)?$/i;

const toSummary = (camera: CameraProfile) => ({
    id: camera.id,
    title: camera.title,
    location: camera.location,
    streamUrl: camera.streamUrl,
    streamType: camera.streamType,
    createdAt: camera.createdAt
});

router.post('/', async (req: Request, res: Response) => {
    try {
        const { deviceId, title, location, streamUrl, streamType } = req.body;
        if (!deviceId || !title || !streamUrl || !streamType) {
            return res.status(200).json({ success: false, error: 'deviceId, title, streamUrl and streamType are required' });
        }

        // Reject at the door rather than queuing something that can never
        // be approved into something playable — only YouTube and HLS are
        // confirmed to actually play anywhere in this app today.
        if (streamType !== 'youtube' && streamType !== 'hls') {
            return res.status(200).json({ success: false, error: 'streamType must be "youtube" or "hls" — no other format can be played by this app yet' });
        }
        if (streamType === 'youtube' && !YOUTUBE_URL_PATTERN.test(streamUrl)) {
            return res.status(200).json({ success: false, error: 'That doesn\'t look like a youtube.com or youtu.be URL' });
        }
        if (streamType === 'hls' && !HLS_URL_PATTERN.test(streamUrl)) {
            return res.status(200).json({ success: false, error: 'An HLS stream URL must end in .m3u8' });
        }

        const camera = await CameraProfile.create({
            submitterDeviceId: deviceId,
            title,
            location: location || null,
            streamUrl,
            streamType,
            status: 'pending'
        });

        res.json({ success: true, camera: { ...toSummary(camera), status: camera.status } });
    } catch (e: any) {
        logger.error(`❌ POST /cameras error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/', async (req: Request, res: Response) => {
    try {
        const cameras = await CameraProfile.findAll({ where: { status: 'approved' }, order: [['createdAt', 'DESC']] });
        res.json({ success: true, cameras: cameras.map(toSummary) });
    } catch (e: any) {
        logger.error(`❌ GET /cameras error: ${e.message}`);
        res.status(200).json({ success: false, cameras: [], error: e.message });
    }
});

/**
 * Admin-only — exact copy of gameRoutes.ts's shared-secret pattern. An
 * internal tool for reviewing submissions, not a user-facing endpoint; no
 * admin UI screen is built, matching gameRoutes.ts's own precedent.
 */
const requireAdmin = (req: Request, res: Response): boolean => {
    const adminKey = req.header('x-admin-key');
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
        res.status(200).json({ success: false, error: 'Unauthorized' });
        return false;
    }
    return true;
};

router.get('/pending', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
        const cameras = await CameraProfile.findAll({ where: { status: 'pending' }, order: [['createdAt', 'ASC']] });
        res.json({ success: true, cameras: cameras.map(c => ({ ...toSummary(c), submitterDeviceId: c.submitterDeviceId })) });
    } catch (e: any) {
        logger.error(`❌ GET /cameras/pending error: ${e.message}`);
        res.status(200).json({ success: false, cameras: [], error: e.message });
    }
});

router.post('/:id/approve', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
        const camera = await CameraProfile.findByPk(req.params.id);
        if (!camera) return res.status(200).json({ success: false, error: 'Camera not found' });
        camera.status = 'approved';
        await camera.save();
        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ POST /cameras/${req.params.id}/approve error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.post('/:id/decline', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
        const camera = await CameraProfile.findByPk(req.params.id);
        if (!camera) return res.status(200).json({ success: false, error: 'Camera not found' });
        camera.status = 'rejected';
        await camera.save();
        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ POST /cameras/${req.params.id}/decline error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
