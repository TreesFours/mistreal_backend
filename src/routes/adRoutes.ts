import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as admin from 'firebase-admin';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { createAd, getNextAd, isAdDue, isEligibleForAds, trackAdEvent } from '../services/adService';
import { Ad } from '../models/adModel';
import { getActiveConfig, uploadFile as uploadToCloudStorage } from '../services/cloudStorageService';
import logger from '../utils/logger';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const persistToFirebase = async (buffer: Buffer, contentType: string, path: string): Promise<string> => {
    const bucket = admin.storage().bucket();
    const file = bucket.file(path);
    await file.save(buffer, { metadata: { contentType } });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/${path}`;
};

/**
 * Dispatcher: if this device has an active CloudStorageConfig (its own
 * connected cloud account — see cloudStorageRoutes.ts), the file goes
 * there instead of our Firebase bucket; otherwise this behaves exactly
 * like it always has. `deviceId` is new here but every existing call site
 * already has it in scope — this is additive, not a behavior change for
 * anyone without a configured cloud account. A cloud-storage failure
 * (server down, bad credentials) falls back to Firebase rather than
 * failing the whole upload, since Firebase is the one path guaranteed to
 * actually be configured.
 */
export const persistToStorage = async (deviceId: string, buffer: Buffer, contentType: string, path: string): Promise<string> => {
    const activeConfig = await getActiveConfig(deviceId);
    if (activeConfig) {
        try {
            return await uploadToCloudStorage(activeConfig, buffer, contentType, path);
        } catch (e: any) {
            logger.warn(`⚠️ Cloud storage upload failed for device ${deviceId}, falling back to Firebase: ${e.message}`);
        }
    }
    return persistToFirebase(buffer, contentType, path);
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
            videoUrl = await persistToStorage(deviceId, video.buffer, video.mimetype, `ads/${businessId}/${Date.now()}.mp4`);
        } else if (mediaType === 'slideshow') {
            const images = files?.images || [];
            if (images.length < 6 || images.length > 12) {
                return res.status(200).json({ success: false, error: 'A slideshow needs 6 to 12 images.' });
            }
            imageUrls = await Promise.all(
                images.map((img, i) => persistToStorage(deviceId, img.buffer, img.mimetype, `ads/${businessId}/${Date.now()}_${i}.jpg`))
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

/**
 * A business's own ad, for its profile banner — distinct from /due's
 * round-robin feed placement. Loops client-side (restart from the first
 * image once the slideshow/video ends) until the owner replaces it with a
 * new createAd call, which already deletes the prior one (see adService.ts).
 */
router.get('/business/:businessId', async (req: Request, res: Response) => {
    try {
        const ad = await Ad.findOne({ where: { businessId: req.params.businessId, isActive: true } });
        res.json({ success: true, ad });
    } catch (e: any) {
        logger.error(`❌ GET /ads/business/:businessId error: ${e.message}`);
        res.status(200).json({ success: false, ad: null, error: e.message });
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
