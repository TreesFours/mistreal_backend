import { Router, Request, Response } from 'express';
import multer from 'multer';
import { Op } from 'sequelize';
import { UnifiedSocialService } from '../services/socialPlatforms/unified';
import { createConnectSession, getAvailablePlatforms, sendSocialAction, exchangeOAuthCode, disconnectPlatform, getPlatformContacts, getUnreadMessages, getSocialHistory, reconcileUserPlatforms, normalizePlatformId, isPlatformMatching, setContactAutoReply } from '../services/socialService';
import { ZernioAdapter } from '../services/socialPlatforms/zernioAdapter';
import { YoutubeNativeAuth, uploadYoutubeVideo } from '../services/socialPlatforms/youtubeNative';
import { User, SocialEvent } from '../models/userModel';
import { WebhookService } from '../services/webhookService';
import { authenticateUser, optionalAuthenticateUser } from '../utils/authMiddleware';
import logger from '../utils/logger';

import { validate, socialActionSchema } from '../middleware/validationMiddleware';
import { storeMediaBase64, buildMediaUrl } from '../utils/mediaStore';

const router = Router();
const videoUpload = multer({ storage: multer.memoryStorage() });

// Shared by the generic Zernio callback and the dedicated YouTube callback
// below — same look, same auto-redirect-then-manual-button behavior.
const buildConnectSuccessPage = (normPlatform: string, deviceId: string, success: boolean = true): string => {
    const appDeepLink = `mistreal://social-connected?platform=${normPlatform}&success=${success}&deviceId=${deviceId}`;
    return `
        <html>
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }
                    .card { background: #1e293b; padding: 32px; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); max-width: 400px; width: 90%; }
                    h2 { color: #4ade80; margin-bottom: 12px; }
                    p { color: #94a3b8; margin-bottom: 24px; font-size: 14px; }
                    .btn { display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px; transition: background 0.2s; }
                    .btn:hover { background: #4f46e5; }
                </style>
                <script>
                    setTimeout(function() {
                        window.location.href = "${appDeepLink}";
                    }, 500);
                </script>
            </head>
            <body>
                <div class="card">
                    <h2>✅ Connected Successfully!</h2>
                    <p>Your ${normPlatform} account has been successfully linked. Tap below to return to Mistreal.</p>
                    <a href="${appDeepLink}" class="btn">Return to Mistreal App</a>
                </div>
            </body>
        </html>
    `;
};

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
        const connectedPlatforms = user ? await reconcileUserPlatforms(user) : [];
        const platforms = await getAvailablePlatforms(isPro);
        const result = platforms.map(p => ({
            ...p,
            isConnected: connectedPlatforms.some((cp: string) => isPlatformMatching(cp, p.id))
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

    const normPlatform = normalizePlatformId(platform);

    try {
        // Generate a state containing the deviceId so we can map it back in callback
        const state = Buffer.from(JSON.stringify({ deviceId: user.deviceId, platform: normPlatform })).toString('base64');
        const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
        const callbackUrl = `${baseUrl}/api/social/callback?state=${state}`;

        const authUrl = await createConnectSession(normPlatform, user.deviceId, callbackUrl);
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

        const normPlatform = normalizePlatformId(platform);

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
        await exchangeOAuthCode(deviceId, normPlatform, (code || tempToken || 'ACCEPTED') as string, `${baseUrl}/api/social/callback`);

        const verifiedPlatforms = await reconcileUserPlatforms(user);
        const isVerified = verifiedPlatforms.some(p => isPlatformMatching(p, normPlatform)) ||
                           (user.connectedPlatforms || []).some(p => isPlatformMatching(p, normPlatform));

        // Return a professional success handshake page with auto-redirect AND a manual return button
        res.send(buildConnectSuccessPage(normPlatform, deviceId, isVerified));
    } catch (error: any) {
        logger.error(`❌ Callback processing error: ${error.message}`);
        res.status(500).send(`Connection failed: ${error.message}`);
    }
});

/**
 * 2a. YOUTUBE CALLBACK (native Google OAuth — separate from the Zernio
 * callback above since it needs its own fixed redirect_uri registered in
 * Google Cloud Console, and exchanges the code against Google directly
 * rather than through Zernio).
 */
router.get('/youtube/callback', async (req: Request, res: Response) => {
    try {
        const { state, code } = req.query;
        if (!code || !state) return res.status(400).send('Invalid callback parameters');

        const decodedState = JSON.parse(Buffer.from(state as string, 'base64').toString('utf8'));
        const deviceId = decodedState.deviceId as string;
        if (!deviceId) return res.status(400).send('Invalid state parameter');

        const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
        await YoutubeNativeAuth.exchangeCodeAndStore(deviceId, code as string, `${baseUrl}/api/social/youtube/callback`);

        res.send(buildConnectSuccessPage('youtube', deviceId));
    } catch (error: any) {
        logger.error(`❌ YouTube callback error: ${error.message}`);
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
 * 3b. PER-CONTACT GHOST RESPONDER TOGGLE
 * Gates auto-reply for one specific DM thread/minichat. Requires the global
 * guardianEnabled master switch to ALSO be on before it ever actually fires.
 */
router.post('/contacts/auto-reply', optionalAuthenticateUser, async (req: Request, res: Response) => {
    try {
        const user = await getResolvedUser(req);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });

        const { platform, contactId, enabled } = req.body;
        if (!platform || !contactId || typeof enabled !== 'boolean') {
            return res.status(200).json({ success: false, error: 'platform, contactId and enabled are required' });
        }

        await setContactAutoReply(user, platform, contactId, enabled);
        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ POST /contacts/auto-reply error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
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
        const { platform, type, content, targetId, mediaBase64, mediaMimeType, shareToCommunity } = req.body;

        // AI-generated/edited images only exist as base64 — host it briefly on our
        // own backend so Zernio has a real URL to fetch (see mediaStore.ts).
        let mediaUrl: string | undefined;
        if (mediaBase64) {
            const id = storeMediaBase64(mediaBase64, mediaMimeType || 'image/jpeg');
            mediaUrl = buildMediaUrl(id);
        }

        const result = await sendSocialAction(user, { platform, type, content, targetId, mediaUrl, shareToCommunity });
        res.json(result);
    } catch (error: any) { res.status(500).json({ error: error.message }); }
});

/**
 * Native YouTube upload — bypasses the generic /action → Zernio pipeline
 * entirely, since Zernio has no YouTube posting capability at all. Separate
 * multipart route (not mediaBase64) because video needs real file streaming,
 * not a JSON-body base64 blob — same reasoning as the Ads upload route.
 */
router.post('/youtube/upload', authenticateUser, videoUpload.single('video'), async (req: Request, res: Response) => {
    try {
        const { deviceId, title, description, privacyStatus } = req.body;
        if (!deviceId || !title) {
            return res.status(200).json({ success: false, error: 'deviceId and title are required' });
        }
        if (!req.file) {
            return res.status(200).json({ success: false, error: 'A video file is required.' });
        }

        const normalizedPrivacy = ['public', 'unlisted', 'private'].includes(privacyStatus) ? privacyStatus : 'public';
        const result = await uploadYoutubeVideo(deviceId, req.file.buffer, title, description || '', normalizedPrivacy);
        res.json({ success: true, videoId: result.videoId, url: result.url });
    } catch (error: any) {
        logger.error(`❌ YouTube upload error: ${error.message}`);
        res.status(200).json({ success: false, error: error.message });
    }
});

router.get('/youtube/status', optionalAuthenticateUser, async (req: Request, res: Response) => {
    try {
        const deviceId = (req.query.deviceId) as string;
        if (!deviceId) return res.status(200).json({ success: false, connected: false, error: 'deviceId required' });
        const connected = await YoutubeNativeAuth.isConnected(deviceId);
        res.json({ success: true, connected });
    } catch (error: any) {
        res.status(200).json({ success: false, connected: false, error: error.message });
    }
});

// Which platforms' Community Feed content this viewer wants to see —
// empty by default, so the feature stays fully off until explicitly opted
// into per platform.
router.patch('/community-preferences', async (req: Request, res: Response) => {
    try {
        const { platforms } = req.body;
        if (!Array.isArray(platforms)) {
            return res.status(200).json({ success: false, error: 'a platforms array is required' });
        }
        const user = await getResolvedUser(req);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });

        user.set('preferences', { ...user.preferences, communityFeedPlatforms: platforms });
        user.changed('preferences', true);
        await user.save();

        res.json({ success: true, platforms });
    } catch (error: any) {
        res.status(200).json({ success: false, error: error.message });
    }
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