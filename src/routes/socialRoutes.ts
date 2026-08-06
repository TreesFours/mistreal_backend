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

// 📱 Get Available Platforms
router.get('/platforms', async (req: Request, res: Response) => {
    const { deviceId } = req.query;
    let isPro = false;
    if (deviceId) {
        const user = await getOrCreateUser(String(deviceId));
        isPro = user?.isPro ?? false;
    }
    const platforms = await getAvailablePlatforms(isPro);
    res.json(platforms);
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

    // Redirect back to app with success
    res.redirect(
        `mistreal://social-connected?platform=${decodedPlatform}&success=true&deviceId=${deviceId}`
    );
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
