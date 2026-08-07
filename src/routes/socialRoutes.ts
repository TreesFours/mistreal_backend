import { Router, Request, Response } from 'express';
import { UnifiedSocialService } from '../services/socialPlatforms/unified';
import { createConnectSession, getAvailablePlatforms, sendSocialAction } from '../services/socialService';
import { User } from '../models/userModel';

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
    const authUrl = await createConnectSession(platform as string, deviceId as string);
    // REDIRECT instead of returning JSON
    res.redirect(authUrl);
  } catch (error: any) {
    console.error(`Failed to create connection for ${platform}:`, error.message);
    res.status(500).send(`Connection System Error: ${error.message}`);
  }
});

/**
 * 🏁 ZERNIO CALLBACK HANDLER
 * Zernio redirects here after a user connects an account.
 * Since Zernio manages tokens, we just need to ensure our local 'User'
 * knows that the platform is connected and we can trigger a sync.
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { state, platform, error: oauthError } = req.query;

    // Decode state
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

    if (oauthError) {
      return res.redirect(
        `mistreal://social-connected?platform=${decodedPlatform}&success=false&error=${oauthError}&deviceId=${deviceId}`
      );
    }

    // Find or create user
    const user = await getOrCreateUser(deviceId);
    if (!user) {
        throw new Error('Failed to find or create user');
    }

    // Add canonical platform ID into connectedPlatforms so we know to sync it via Zernio
    const connectedPlatforms = user.connectedPlatforms || [];
    if (!connectedPlatforms.includes(decodedPlatform)) {
        connectedPlatforms.push(decodedPlatform);
        user.connectedPlatforms = connectedPlatforms;
    }

    await user.save();

    // 🏆 Success Response: Show a friendly HTML page before redirecting (or instead of)
    res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #000; color: #fff; text-align: center; }
            .card { background: #111; padding: 2rem; border-radius: 20px; border: 1px solid #333; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
            h1 { color: #81C784; margin-bottom: 0.5rem; }
            p { opacity: 0.8; margin-bottom: 2rem; }
            .btn { background: #81C784; color: #000; padding: 12px 24px; border-radius: 12px; text-decoration: none; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Linked Successfully!</h1>
            <p>Mistreal AI is now connected to your ${decodedPlatform} account.</p>
            <p><b>Please close this browser window and return to the app.</b></p>
            <a href="mistreal://social-connected?platform=${decodedPlatform}&success=true&deviceId=${deviceId}" class="btn">Return to App</a>
          </div>
          <script>
            // Attempt auto-redirect after 3 seconds
            setTimeout(() => {
              window.location.href = "mistreal://social-connected?platform=${decodedPlatform}&success=true&deviceId=${deviceId}";
            }, 3000);
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

export default router;
