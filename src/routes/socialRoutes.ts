import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { UnifiedSocialService } from '../services/socialPlatforms/unified';
import { createConnectSession, getAvailablePlatforms, sendSocialAction, exchangeOAuthCode, disconnectPlatform, getPlatformContacts, getUnreadMessages, getSocialHistory } from '../services/socialService';
import { ZernioAdapter } from '../services/socialPlatforms/zernioAdapter';
import { User, SocialEvent } from '../models/userModel';
import { WebhookService } from '../services/webhookService';
import { authenticateUser, optionalAuthenticateUser } from '../utils/authMiddleware';
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
        if (!user && deviceId) {
            user = await User.create({ deviceId, connectedPlatforms: [] });
        }
        return user;
    } catch (e: any) {
        logger.error(`Error in getResolvedUser: ${e.message}`);
        return null;
    }
};

// 📱 Get Available Platforms
router.get('/platforms', optionalAuthenticateUser, async (req: Request, res: Response) => {
    try {
        const user = await getResolvedUser(req);
        const isPro = user?.isPro ?? false;
        const connectedPlatforms = user?.connectedPlatforms || [];
        const platforms = await getAvailablePlatforms(isPro);
        const result = platforms.map(p => ({
            ...p,
            isConnected: connectedPlatforms.includes(p.id)
        }));
        res.json(result);
    } catch (e: any) {
        res.status(200).json([]);
    }
});

// === NEW: PROFESSIONAL OAUTH HANDSHAKE ===

/**
 * 1. INIT CONNECTION
 * Returns the Zernio connect URL for the specific platform.
 */
router.post('/init-connection', optionalAuthenticateUser, async (req: Request, res: Response) => {
    const { platform } = req.body;
    const deviceId = (req.query.deviceId || req.body.deviceId) as string;

    if (!platform) {
        return res.status(200).json({ success: false, error: 'Platform is required' });
    }

    const user = await getResolvedUser(req);
    if (!user) {
        return res.status(200).json({ success: false, error: 'User resolve failed' });
    }

    try {
        // Generate a state containing the deviceId so we can map it back in callback
        const state = Buffer.from(JSON.stringify({ deviceId: user.deviceId, platform })).toString('base64');
        const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
        const callbackUrl = `${baseUrl}/api/social/callback?state=${state}`;

        const authUrl = await createConnectSession(platform, user.deviceId, callbackUrl);
        return res.status(200).json({ success: true, connectUrl: authUrl });
    } catch (error: any) {
        logger.error(`❌ init-connection failed for platform ${platform}: ${error.message}`);
        return res.status(200).json({ success: false, error: error.message || 'Connection initiation failed' });
    }
});

/**
 * 2. CALLBACK HANDLER
 * Handles the redirect from Zernio and triggers Finalization.
 */
router.get('/callback', async (req: Request, res: Response) => {
    try {
        const { state, code, tempToken, profileId, deviceId: queryDeviceId, platform: queryPlatform } = req.query;

        let deviceId = queryDeviceId as string;
        let platform = queryPlatform as string;

        if (state) {
            try {
                const normalizedState = (state as string).replace(/-/g, '+').replace(/_/g, '/');
                const decodedState = JSON.parse(Buffer.from(normalizedState, 'base64').toString('utf8'));
                deviceId = deviceId || decodedState.deviceId;
                platform = platform || decodedState.platform;
            } catch (e) {
                logger.warn('Failed to parse callback state param, using query parameters fallback');
            }
        }

        if (!deviceId || !platform) {
            return res.status(400).send('Invalid callback parameters');
        }

        let user = await User.findOne({ where: { deviceId } });
        if (!user) {
            user = await User.create({ deviceId, connectedPlatforms: [] });
        }

        // Finalize Zernio Mapping
        if (profileId) {
            user.zernioProfileId = profileId as string;
            await user.save();
        }

        const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
        await exchangeOAuthCode(deviceId, platform, (code || tempToken || 'ACCEPTED') as string, `${baseUrl}/api/social/callback`);

        const appDeepLink = `mistreal://social-connected?platform=${platform}&success=true&deviceId=${deviceId}`;

        // Return a friendly handshake page that redirects to the app
        res.send(`<html><body><script>window.location.href="${appDeepLink}";</script>Redirecting to Mistreal...</body></html>`);
    } catch (error: any) {
        logger.error(`❌ Callback processing error: ${error.message}`);
        res.status(500).send(`Connection failed: ${error.message}`);
    }
});

/**
 * 2b. CALLBACK SUCCESS ALIAS
 * Direct alias handler for headless completion redirect.
 */
router.get('/callback/success', async (req: Request, res: Response) => {
    const { platform, deviceId } = req.query;
    const targetPlatform = (platform as string) || 'social';
    const targetDevice = (deviceId as string) || '';
    const appDeepLink = `mistreal://social-connected?platform=${targetPlatform}&success=true&deviceId=${targetDevice}`;
    res.send(`<html><body><script>window.location.href="${appDeepLink}";</script>Redirecting to Mistreal...</body></html>`);
});

/**
 * 3. CONTACTS FEED
 */
router.get('/contacts', optionalAuthenticateUser, async (req: Request, res: Response) => {
    try {
        const user = await getResolvedUser(req);
        if (!user) return res.status(200).json({ success: false, contacts: [] });

        const platform = (req.query.platform as string) || 'all';
        const search = req.query.search as string;

        const contacts = await getPlatformContacts(user, platform, search);
        res.json({ success: true, contacts });
    } catch (e: any) {
        logger.error(`❌ GET /contacts error: ${e.message}`);
        res.status(200).json({ success: false, contacts: [] });
    }
});

/**
 * 4. UNREAD MESSAGES FEED
 */
router.get('/unread', optionalAuthenticateUser, async (req: Request, res: Response) => {
    try {
        const user = await getResolvedUser(req);
        if (!user) return res.status(200).json({ success: false, unreadItems: [] });

        const unreadItems = await getUnreadMessages(user);
        res.json({ success: true, unreadItems });
    } catch (e: any) {
        logger.error(`❌ GET /unread error: ${e.message}`);
        res.status(200).json({ success: false, unreadItems: [] });
    }
});

/**
 * 5. SOCIAL HISTORY FEED
 */
router.get('/history', optionalAuthenticateUser, async (req: Request, res: Response) => {
    try {
        const user = await getResolvedUser(req);
        if (!user) return res.status(200).json({ success: false, messages: [] });

        const platform = (req.query.platform as string) || '';
        const targetId = (req.query.targetId as string) || '';

        const messages = await getSocialHistory(user, platform, targetId);
        res.json({ success: true, messages });
    } catch (e: any) {
        logger.error(`❌ GET /history error: ${e.message}`);
        res.status(200).json({ success: false, messages: [] });
    }
});

/**
 * 6. DISCONNECT PLATFORM
 */
router.post('/disconnect/:platform', optionalAuthenticateUser, async (req: Request, res: Response) => {
    try {
        const deviceId = (req.query.deviceId || req.body.deviceId) as string;
        const platform = req.params.platform;
        if (!deviceId || !platform) {
            return res.status(200).json({ success: false, error: 'Missing deviceId or platform' });
        }
        const outcome = await disconnectPlatform(deviceId, platform);
        res.json(outcome);
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
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