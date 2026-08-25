import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { UnifiedSocialService } from '../services/socialPlatforms/unified';
import { createConnectSession, getAvailablePlatforms, sendSocialAction, exchangeOAuthCode, disconnectPlatform } from '../services/socialService';
import { ZernioAdapter } from '../services/socialPlatforms/zernioAdapter';
import { User, SocialEvent } from '../models/userModel';
import { WebhookService } from '../services/webhookService';
import { authenticateUser } from '../utils/authMiddleware';
import logger from '../utils/logger';

import { validate, socialActionSchema } from '../middleware/validationMiddleware';

const router = Router();

// 🛡️ STRATEGIC USER RESOLUTION
const getResolvedUser = async (req: any) => {
    const deviceId = (req.query.deviceId || req.body.deviceId) as string;
    const firebaseUid = req.user?.uid;
    try {
        let user: User | null = null;
        if (firebaseUid) user = await User.findOne({ where: { firebaseUid } });
        if (!user && deviceId) user = await User.findOne({ where: { deviceId } });
        return user;
    } catch (e) { return null; }
};

// 📱 Get Available Platforms
router.get('/platforms', authenticateUser, async (req: Request, res: Response) => {
    const user = await getResolvedUser(req);
    const isPro = user?.isPro ?? false;
    const connectedPlatforms = user?.connectedPlatforms || [];
    const platforms = await getAvailablePlatforms(isPro);
    const result = platforms.map(p => ({
        ...p,
        isConnected: connectedPlatforms.includes(p.id)
    }));
    res.json(result);
});

// === NEW: PROFESSIONAL OAUTH HANDSHAKE ===

/**
 * 1. INIT CONNECTION
 * Returns the Zernio connect URL for the specific platform.
 */
router.post('/init-connection', authenticateUser, async (req: Request, res: Response) => {
    const { platform } = req.body;
    const user = await getResolvedUser(req);
    if (!user) return res.status(404).json({ error: 'User not found' });

    try {
        // Generate a state containing the deviceId so we can map it back in callback
        const state = Buffer.from(JSON.stringify({ deviceId: user.deviceId, platform })).toString('base64');
        const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
        const callbackUrl = `${baseUrl}/api/social/callback?state=${state}`;

        const authUrl = await createConnectSession(platform, user.deviceId, callbackUrl);
        res.json({ success: true, connectUrl: authUrl });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 2. CALLBACK HANDLER
 * Handles the redirect from Zernio and triggers Finalization.
 */
router.get('/callback', async (req: Request, res: Response) => {
    try {
        const { state, code, tempToken, profileId } = req.query;
        const decodedState = JSON.parse(Buffer.from(state as string, 'base64').toString('utf8'));
        const { deviceId, platform } = decodedState;

        const user = await User.findOne({ where: { deviceId } });
        if (!user) throw new Error('User session expired');

        // Finalize Zernio Mapping
        if (profileId) {
            user.zernioProfileId = profileId as string;
            await user.save();
        }

        if (code || tempToken) {
            const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
            await exchangeOAuthCode(deviceId, platform, (code || tempToken) as string, `${baseUrl}/api/social/callback`);
        }

        const appDeepLink = `mistreal://social-connected?platform=${platform}&success=true&deviceId=${deviceId}`;

        // Return a friendly handshake page that redirects to the app
        res.send(`<html><body><script>window.location.href="${appDeepLink}";</script>Redirecting to Mistreal...</body></html>`);
    } catch (error: any) {
        res.status(500).send('Connection failed');
    }
});

// === EXISTING ROUTES ===
router.post('/action', authenticateUser, validate(socialActionSchema), async (req: Request, res: Response) => {
    try {
        const user = await getResolvedUser(req);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const { platform, type, content, targetId } = req.body;
        const result = await sendSocialAction(user, { platform, type, content, targetId });
        res.json(result);
    } catch (error: any) { res.status(500).json({ error: error.message }); }
});

router.post('/webhook', async (req: Request, res: Response) => {
    const signature = (req.headers['x-zernio-signature'] || req.headers['x-late-signature']) as string;
    const payload = JSON.stringify(req.body);

    if (process.env.ZERNIO_WEBHOOK_SECRET && !WebhookService.verifySignature(payload, signature)) {
        return res.status(401).send('Invalid Signature');
    }

    res.status(200).send('OK');
    const eventBody = { ...req.body };
    if (!eventBody.event && req.headers['x-late-event']) eventBody.event = req.headers['x-late-event'];
    WebhookService.handleEvent(eventBody).catch(err => logger.error(`❌ Webhook Error: ${err.message}`));
});

export default router;