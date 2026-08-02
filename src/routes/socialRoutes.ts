import { Router, Request, Response } from 'express';
import { UnifiedSocialService } from '../services/socialPlatforms/unified';
import { createConnectSession, getAvailablePlatforms, exchangeOAuthCode } from '../services/socialService';
import { getPlatformDefinition } from '../services/socialPlatforms/platformRegistry';
import { User } from '../models/userModel';

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

// 📱 Get Available Platforms (RESTORED HERE)
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
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

  try {
    const authUrl = await createConnectSession(platform as string, deviceId as string);
    res.json({ authUrl, deviceId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, platform, error: oauthError } = req.query;

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

    if (!code || !deviceId) {
      return res.redirect(
        `mistreal://social-connected?platform=${decodedPlatform}&success=false&error=Missing code or deviceId&deviceId=${deviceId}`
      );
    }

    try {
      // Exchange code for token
      const tokenData = await exchangeOAuthCode(decodedPlatform, code as string);

      // Find or create user
      const user = await getOrCreateUser(deviceId);
      if (!user) {
        throw new Error('Failed to find or create user');
      }

      // Store platform token generically using registry metadata
      const platformDefinition = getPlatformDefinition(decodedPlatform);
      if (!platformDefinition) {
        throw new Error(`Unsupported platform: ${decodedPlatform}`);
      }

      const tokenField = platformDefinition.tokenField;
      if (tokenField) {
        (user as any)[tokenField] = tokenData.accessToken;
      }

      if (platformDefinition.refreshTokenField) {
        (user as any)[platformDefinition.refreshTokenField] = tokenData.refreshToken || null;
      }

      // Add canonical platform ID into connectedPlatforms
      const connectedPlatforms = user.connectedPlatforms || [];
      const canonicalPlatform = platformDefinition.id;
      if (!connectedPlatforms.includes(canonicalPlatform)) {
        connectedPlatforms.push(canonicalPlatform);
        user.connectedPlatforms = connectedPlatforms;
      }

      await user.save();

      // Redirect back to app with success
      res.redirect(
        `mistreal://social-connected?platform=${decodedPlatform}&success=true&deviceId=${deviceId}`
      );
    } catch (tokenError: any) {
      console.error('Token exchange error:', tokenError.message);
      res.redirect(
        `mistreal://social-connected?platform=${decodedPlatform}&success=false&error=${encodeURIComponent(
          tokenError.message
        )}&deviceId=${deviceId}`
      );
    }
  } catch (error: any) {
    console.error('Callback handler error:', error.message);
    res.redirect(`mistreal://social-connected?success=false&error=${error.message}`);
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

    if (!user.connectedPlatforms || user.connectedPlatforms.length === 0) {
        return res.status(200).json({ summary: "CONNECTION_REQUIRED", posts: [], platformUpdates: [] });
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

        // Clear access token for this platform
        const platformLower = platform.toLowerCase();
        if (platformLower === 'twitter' || platformLower === 'x') {
            user.twitterAccessToken = null;
            user.twitterRefreshToken = null;
        } else if (platformLower === 'instagram') {
            user.instagramAccessToken = null;
        } else if (platformLower === 'whatsapp' || platformLower === 'whatsapp_business') {
            user.whatsappAccessToken = null;
        } else if (platformLower === 'facebook') {
            user.facebookAccessToken = null;
        } else if (platformLower === 'linkedin') {
            user.linkedinAccessToken = null;
        }

        await user.save();
    }
    res.json({ success: true, platform, message: `${platform} disconnected` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
