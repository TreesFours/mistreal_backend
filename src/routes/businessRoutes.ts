import { Router, Request, Response } from 'express';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { Business } from '../models/businessModel';
import logger from '../utils/logger';

const router = Router();

/**
 * Minimal server-side mirror of a locally-registered BusinessEntity — just
 * enough (name/logo/category/owner) for Ad.businessId to FK against
 * something real. Called alongside the existing local-only
 * BusinessRepository.saveBusiness(), not a replacement for it.
 */
router.post('/register', async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, businessId, name, logoUrl, category } = req.body;
        if (!deviceId || !businessId || !name || !category) {
            return res.status(200).json({ success: false, error: 'deviceId, businessId, name and category are required' });
        }

        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) {
            return res.status(200).json({ success: false, error: 'User resolve failed' });
        }

        await Business.upsert({
            businessId,
            ownerDeviceId: deviceId,
            ownerFirebaseUid: firebaseUid || null,
            name,
            logoUrl: logoUrl || null,
            category
        });

        res.json({ success: true, businessId });
    } catch (e: any) {
        logger.error(`❌ POST /business/register error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
