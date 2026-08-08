import { Router, Request, Response } from 'express';
import { UnifiedSocialService } from '../services/socialPlatforms/unified';
import { createConnectSession, getAvailablePlatforms, sendSocialAction, exchangeOAuthCode } from '../services/socialService';
import { User } from '../models/userModel';
import { WebhookService } from '../services/webhookService';
import logger from '../utils/logger';

import { validate, socialActionSchema } from '../middleware/validationMiddleware';

const router = Router();

// 🛡️ Internal Helper
const getOrCreateUser = async (deviceId: string) => {
    try {
        const [user] = await User.findOrCreate({
            where: { deviceId },
            defaults: { deviceId, isPro: false, subscriptionTier: 'free' }
        });
        return user;
    } catch (e) { return null; }
};

// 📱 Get Available Platforms (Now includes connection status)
router.get('/platforms', async (req: Request, res: Response) => {
    const { deviceId } = req.query;
    let isPro = false;
    let connectedPlatforms: string[] = [];

    if (deviceId) {
        const user = await getOrCreateUser(String(deviceId));
        isPro = user?.isPro ?? false;
        connectedPlatforms = user?.connectedPlatforms || [];
    }

    const platforms = await getAvailablePlatforms(isPro);

    // Merge connection status
    const result = platforms.map(p => ({
        ...p,
        isConnected: connectedPlatforms.includes(p.id)
    }));

    res.json(result);
});

// === PROFESSIONAL DIRECT OAUTH ROUTES ===
router.get('/connect/:platform', async (req: Request, res: Response) => {
  const { platform } = req.params;
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).send('Device ID is required');

  try {
    const callbackUrl = `${process.env.APP_URL || 'https://mistreal-backend.onrender.com'}/api/social/callback`;
    const authUrl = await createConnectSession(platform as string, deviceId as string, callbackUrl);
    // DIRECT OAUTH REDIRECT - No intermediate dashboard
    res.redirect(authUrl);
  } catch (error: any) {
    console.error(`Failed to create connection for ${platform}:`, error.message);
    res.status(500).send(`Connection System Error: ${error.message}`);
  }
});

/**
 * 🏁 UNIFIED OAUTH CALLBACK HANDLER
 * Direct OAuth handlers redirect here after success.
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { state, code, platform, error: oauthError } = req.query;

    // Decode state (Base64 JSON: {deviceId, platform})
    let deviceId: string = '';
    let decodedPlatform: string = '';
    try {
      const decoded = JSON.parse(Buffer.from(state as string, 'base64').toString());
      deviceId = decoded.deviceId || '';
      decodedPlatform = decoded.platform || (platform as string);
    } catch (e) {
      console.error('Failed to decode state:', e);
      return res.redirect(`mistreal://social-connected?success=false&error=Invalid state`);
    }

    if (oauthError || !code) {
      return res.redirect(
        `mistreal://social-connected?platform=${decodedPlatform}&success=false&error=${oauthError || 'Auth denied'}&deviceId=${deviceId}`
      );
    }

    // 🚀 Exchange code for Token and save to User
    const callbackUrl = `${process.env.APP_URL || 'https://mistreal-backend.onrender.com'}/api/social/callback`;
    await exchangeOAuthCode(deviceId, decodedPlatform, code as string, callbackUrl);

    // 🚀 CRITICAL REDIRECT: Immediate Deep Link Handshake
    const appDeepLink = `mistreal://social-connected?platform=${decodedPlatform}&success=true&deviceId=${deviceId}`;

    // 🏆 Friendly Handshake Page
    res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #000; color: #fff; text-align: center; }
            .card { background: #111; padding: 2.5rem; border-radius: 24px; border: 1px solid #333; box-shadow: 0 10px 40px rgba(0,0,0,0.8); }
            h1 { color: #81C784; margin-bottom: 0.5rem; font-size: 1.8rem; }
            p { opacity: 0.7; margin-bottom: 2rem; font-size: 1.1rem; }
            .loader { border: 3px solid #333; border-top: 3px solid #81C784; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .btn { background: #81C784; color: #000; padding: 14px 28px; border-radius: 12px; text-decoration: none; font-weight: bold; display: inline-block; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="loader"></div>
            <h1>Intelligence Secured</h1>
            <p>Mistreal AI is now linked to your <b>${decodedPlatform}</b>.</p>
            <a href="${appDeepLink}" class="btn">Return to Agent</a>
          </div>
          <script>
            // Silent Handshake: Immediate auto-redirect
            window.location.href = "${appDeepLink}";
            setTimeout(() => { window.location.href = "${appDeepLink}"; }, 1000);
          </script>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error('Callback handler error:', error.message);
    res.redirect(`mistreal://social-connected?success=false&error=${error.message}`);
  }
});

router.post('/action', validate(socialActionSchema), async (req: Request, res: Response) => {
  try {
    const { deviceId, platform, type, content, targetId } = req.body;
    const user = await User.findOne({ where: { deviceId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await sendSocialAction(user, { platform, type, content, targetId });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/sync', async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const user = await User.findOne({ where: { deviceId } });

    if (!user) {
        return res.status(200).json({ summary: "USER_NOT_FOUND", posts: [], platformUpdates: [] });
    }

    const result = await UnifiedSocialService.syncAllPlatforms(user);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Added GET support for sync to match Android app
router.get('/sync', async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const user = await User.findOne({ where: { deviceId: String(deviceId) } });

    if (!user) {
        return res.status(200).json({ summary: "USER_NOT_FOUND", posts: [], platformUpdates: [] });
    }

    const result = await UnifiedSocialService.syncAllPlatforms(user);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/contacts', async (req: Request, res: Response) => {
  try {
    const { deviceId, platform } = req.query;
    // Implementation of contacts fetch from Zernio would go here
    // For now, return empty list to avoid 404
    res.json({ success: true, contacts: [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/unread', async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const user = await User.findOne({ where: { deviceId: String(deviceId) } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Retrieve unread items from preferences.unreadMetadata populated by WebhookService
    const unreadMetadata = user.preferences?.unreadMetadata || {};
    const unreadItems: any[] = [];

    Object.keys(unreadMetadata).forEach(platform => {
        if (Array.isArray(unreadMetadata[platform])) {
            unreadMetadata[platform].forEach((item: any) => {
                unreadItems.push({
                    id: item.id,
                    sender: item.sender,
                    platform: platform,
                    text: item.content || item.type,
                    timestamp: item.timestamp,
                    isOnline: false, // Defaulting to false as real-time online status requires separate tracking
                    lastSeen: null
                });
            });
        }
    });

    // Sort by timestamp newest first
    unreadItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json({ success: true, unreadItems });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/disconnect/:platform', async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;
    const { platform } = req.params;
    const user = await User.findOne({ where: { deviceId } });

    if (user) {
        const platforms = user.connectedPlatforms || [];
        user.connectedPlatforms = platforms.filter(p => p.toLowerCase() !== platform.toLowerCase());
        await user.save();
    }
    res.json({ success: true, platform, message: `${platform} disconnected` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 🛰️ UNIFIED SOCIAL WEBHOOK
 * Official entry point for Zernio event orchestration.
 * URL: https://mistreal-backend.onrender.com/api/social/webhook
 */
router.post('/webhook', async (req: Request, res: Response) => {
    const signature = req.headers['x-zernio-signature'] as string;
    const payload = JSON.stringify(req.body);

    // 1. Verify Security (If secret is configured)
    if (process.env.ZERNIO_WEBHOOK_SECRET && !WebhookService.verifySignature(payload, signature)) {
        logger.warn('🚫 Invalid Webhook Signature rejected.');
        return res.status(401).send('Invalid Signature');
    }

    // 2. Respond 200 OK immediately to satisfy Zernio's timeout requirements
    res.status(200).send('OK');

    // 3. Process Event Asynchronously
    WebhookService.handleEvent(req.body).catch(err => {
        logger.error(`❌ Webhook Orchestration Error: ${err.message}`);
    });
});

export default router;
