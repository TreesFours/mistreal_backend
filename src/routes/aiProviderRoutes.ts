import { Router, Request, Response } from 'express';
import { validate, byokKeySchema, byokClearSchema } from '../middleware/validationMiddleware';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { encrypt, isEncryptionConfigured } from '../utils/secretCrypto';
import logger from '../utils/logger';

const router = Router();

/**
 * Bring-your-own-key AI provider configuration. Device-first resolution (same
 * as /api/chat) so device-anonymous users without a Firebase login can still
 * use BYOK — deliberately not folded into userRoutes.ts's firebase-only
 * /settings endpoint, and never echoes the key back in any response.
 */

router.post('/key', validate(byokKeySchema), async (req: Request, res: Response) => {
    try {
        if (!isEncryptionConfigured()) {
            return res.status(503).json({ success: false, error: 'BYOK_UNAVAILABLE: encryption not configured on this server.' });
        }

        const { deviceId, firebaseUid, providerType, apiKey, baseUrl, modelName } = req.body;
        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        user.byokEnabled = true;
        user.byokProviderType = providerType;
        user.byokEncryptedKey = encrypt(apiKey);
        user.byokBaseUrl = providerType === 'openai_compatible' ? (baseUrl ?? null) : null;
        user.byokModelName = modelName ?? null;
        await user.save();

        res.json({
            success: true,
            configured: true,
            providerType: user.byokProviderType,
            modelName: user.byokModelName,
            baseUrl: user.byokBaseUrl
        });
    } catch (error: any) {
        logger.error(`❌ BYOK key save error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/clear', validate(byokClearSchema), async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid } = req.body;
        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        user.byokEnabled = false;
        user.byokProviderType = null;
        user.byokEncryptedKey = null;
        user.byokBaseUrl = null;
        user.byokModelName = null;
        await user.save();

        res.json({ success: true, configured: false });
    } catch (error: any) {
        logger.error(`❌ BYOK key clear error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/status', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });

        const user = await getOrCreateUserInternal(deviceId, req.query.firebaseUid as string | undefined);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        res.json({
            success: true,
            configured: !!user.byokEnabled,
            providerType: user.byokProviderType,
            modelName: user.byokModelName,
            baseUrl: user.byokBaseUrl
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
