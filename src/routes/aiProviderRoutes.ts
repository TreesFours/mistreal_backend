import { Router, Request, Response } from 'express';
import { validate, byokKeySchema, byokClearSchema, byokVideoKeySchema, mediaProviderConfigSchema, mediaProviderActivateSchema } from '../middleware/validationMiddleware';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { encrypt, isEncryptionConfigured } from '../utils/secretCrypto';
import { AiProviderConfig } from '../models/AiProviderConfig';
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

// --- Separate BYOK slot for video editing — same pattern as above, different
// User fields (byokVideo*), since a user might configure a text provider and
// a video provider independently. See userModel.ts for why this isn't just
// another providerType value on the slot above. ---

router.post('/video-key', validate(byokVideoKeySchema), async (req: Request, res: Response) => {
    try {
        if (!isEncryptionConfigured()) {
            return res.status(503).json({ success: false, error: 'BYOK_UNAVAILABLE: encryption not configured on this server.' });
        }

        const { deviceId, firebaseUid, providerType, apiKey, baseUrl, modelName } = req.body;
        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        user.byokVideoEnabled = true;
        user.byokVideoProviderType = providerType;
        user.byokVideoEncryptedKey = encrypt(apiKey);
        user.byokVideoBaseUrl = baseUrl ?? null;
        user.byokVideoModelName = modelName ?? null;
        await user.save();

        res.json({
            success: true,
            configured: true,
            providerType: user.byokVideoProviderType,
            modelName: user.byokVideoModelName,
            baseUrl: user.byokVideoBaseUrl
        });
    } catch (error: any) {
        logger.error(`❌ BYOK video key save error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/video-clear', validate(byokClearSchema), async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid } = req.body;
        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        user.byokVideoEnabled = false;
        user.byokVideoProviderType = null;
        user.byokVideoEncryptedKey = null;
        user.byokVideoBaseUrl = null;
        user.byokVideoModelName = null;
        await user.save();

        res.json({ success: true, configured: false });
    } catch (error: any) {
        logger.error(`❌ BYOK video key clear error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/video-status', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });

        const user = await getOrCreateUserInternal(deviceId, req.query.firebaseUid as string | undefined);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        res.json({
            success: true,
            configured: !!user.byokVideoEnabled,
            providerType: user.byokVideoProviderType,
            modelName: user.byokVideoModelName,
            baseUrl: user.byokVideoBaseUrl
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Saved image/video GENERATION provider configs ---
// Unlike the single-slot BYOK sections above, a user can save SEVERAL of
// these per capability and switch which one is active (or fall back to "Our
// Recommended" — Imagen/Veo) rather than overwriting a single slot. This is
// the gap image/video generation had with no BYOK story at all before now.

router.post('/media-configs', validate(mediaProviderConfigSchema), async (req: Request, res: Response) => {
    try {
        if (!isEncryptionConfigured()) {
            return res.status(503).json({ success: false, error: 'BYOK_UNAVAILABLE: encryption not configured on this server.' });
        }
        const { deviceId, firebaseUid, capability, label, providerType, apiKey, baseUrl, modelName } = req.body;
        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        const config = await AiProviderConfig.create({
            deviceId, capability, label, providerType,
            encryptedKey: encrypt(apiKey),
            baseUrl: baseUrl ?? null,
            modelName: modelName ?? null
        });

        res.json({
            success: true,
            config: { id: config.id, capability: config.capability, label: config.label, providerType: config.providerType, modelName: config.modelName }
        });
    } catch (error: any) {
        logger.error(`❌ Media provider config save error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/media-configs', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        const capability = req.query.capability as string;
        if (!deviceId || !capability) return res.status(400).json({ success: false, error: 'deviceId and capability are required' });

        const user = await getOrCreateUserInternal(deviceId, req.query.firebaseUid as string | undefined);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        const configs = await AiProviderConfig.findAll({ where: { deviceId, capability } });
        const activeId = capability === 'image_gen' ? user.activeImageGenConfigId : user.activeVideoGenConfigId;

        res.json({
            success: true,
            activeConfigId: activeId ?? null,
            configs: configs.map((c: any) => ({ id: c.id, label: c.label, providerType: c.providerType, modelName: c.modelName }))
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/media-configs/activate', validate(mediaProviderActivateSchema), async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, capability, configId } = req.body;
        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        // null/omitted configId = "Our Recommended"
        if (configId != null) {
            const config = await AiProviderConfig.findOne({ where: { id: configId, deviceId, capability } });
            if (!config) return res.status(404).json({ success: false, error: 'Saved provider not found' });
        }

        if (capability === 'image_gen') user.activeImageGenConfigId = configId ?? null;
        else user.activeVideoGenConfigId = configId ?? null;
        await user.save();

        res.json({ success: true, activeConfigId: configId ?? null });
    } catch (error: any) {
        logger.error(`❌ Media provider activate error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/media-configs/:id', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });

        const id = Number(req.params.id);
        const config = await AiProviderConfig.findOne({ where: { id, deviceId } });
        if (!config) return res.status(404).json({ success: false, error: 'Saved provider not found' });

        const user = await getOrCreateUserInternal(deviceId, req.query.firebaseUid as string | undefined);
        // Deactivating config falls back to "Our Recommended" if it was active.
        if (user) {
            if (user.activeImageGenConfigId === id) { user.activeImageGenConfigId = null; await user.save(); }
            if (user.activeVideoGenConfigId === id) { user.activeVideoGenConfigId = null; await user.save(); }
        }

        await config.destroy();
        res.json({ success: true });
    } catch (error: any) {
        logger.error(`❌ Media provider config delete error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
