import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as admin from 'firebase-admin';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { createAd, getNextAd, isAdDue, isEligibleForAds, trackAdEvent } from '../services/adService';
import logger from '../utils/logger';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const persistToStorage = async (buffer: Buffer, contentType: string, path: string): Promise<string> => {
    const bucket = admin.storage().bucket();
    const file = bucket.file(path);
    await file.save(buffer, { metadata: { contentType } });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/${path}`;
};

router.post('/', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'images', maxCount: 12 }]), async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, businessId, mediaType, durationSeconds, caption, targetUrl, ctaLabel } = req.body;
        if (!deviceId || !businessId || !mediaType || !durationSeconds) {
            return res.status(200).json({ success: false, error: 'deviceId, businessId, mediaType and durationSeconds are required' });
        }

        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });
        if (!isEligibleForAds(user)) {
            return res.status(200).json({ success: false, error: 'Creating ads requires at least Premium tier 1.' });
        }

        const files = req.files as { video?: Express.Multer.File[], images?: Express.Multer.File[] };
        let videoUrl: string | undefined;
        let imageUrls: string[] | undefined;

        if (mediaType === 'video') {
            const video = files?.video?.[0];
            if (!video) return res.status(200).json({ success: false, error: 'A video file is required.' });
            videoUrl = await persistToStorage(video.buffer, video.mimetype, `ads/${businessId}/${Date.now()}.mp4`);
        } else if (mediaType === 'slideshow') {
            const images = files?.images || [];
            if (images.length < 6 || images.length > 12) {
                return res.status(200).json({ success: false, error: 'A slideshow needs 6 to 12 images.' });
            }
            imageUrls = await Promise.all(
                images.map((img, i) => persistToStorage(img.buffer, img.mimetype, `ads/${businessId}/${Date.now()}_${i}.jpg`))
            );
        } else {
            return res.status(200).json({ success: false, error: 'mediaType must be "video" or "slideshow".' });
        }

        const ad = await createAd({
            businessId,
            ownerDeviceId: deviceId,
            mediaType,
            videoUrl,
            imageUrls,
            durationSeconds: Number(durationSeconds),
            caption,
            targetUrl,
            ctaLabel
        });

        res.json({ success: true, adId: ad.id });
    } catch (e: any) {
        logger.error(`❌ POST /ads error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/due', async (req: Request, res: Response) => {
    try {
        const { deviceId } = req.query;
        if (!deviceId) return res.status(200).json({ success: false, due: false, ad: null, error: 'deviceId is required' });

        const due = await isAdDue(String(deviceId));
        if (!due) return res.json({ success: true, due: false, ad: null });

        const ad = await getNextAd();
        if (!ad) return res.json({ success: true, due: false, ad: null });

        res.json({
            success: true,
            due: true,
            ad: {
                id: ad.id,
                mediaType: ad.mediaType,
                videoUrl: ad.videoUrl,
                imageUrls: ad.imageUrls,
                durationSeconds: ad.durationSeconds,
                caption: ad.caption,
                targetUrl: ad.targetUrl,
                ctaLabel: ad.ctaLabel
            }
        });
    } catch (e: any) {
        logger.error(`❌ GET /ads/due error: ${e.message}`);
        res.status(200).json({ success: false, due: false, ad: null, error: e.message });
    }
});

router.post('/:adId/track', async (req: Request, res: Response) => {
    try {
        const { adId } = req.params;
        const { deviceId, eventType } = req.body;
        if (!deviceId || !['impression', 'engaged_click'].includes(eventType)) {
            return res.status(200).json({ success: false, error: 'deviceId and a valid eventType are required' });
        }
        await trackAdEvent(Number(adId), deviceId, eventType);
        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ POST /ads/:adId/track error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
