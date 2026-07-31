// backend/src/routes/socialRoutes.ts
// Professional OAuth authentication endpoints for Dynamic Social Integration

import { Router, Request, Response } from 'express';
import { UnifiedSocialService } from '../services/socialPlatforms/unified';
import { createConnectSession } from '../services/socialService';
import { User } from '../models/userModel';

const router = Router();

// === PROFESSIONAL DYNAMIC OAUTH ROUTES ===
router.get('/connect/:platform', async (req: Request, res: Response) => {
  const { platform } = req.params;
  const { deviceId } = req.query;
  
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

  try {
    const authUrl = await createConnectSession(platform as string);
    // Note: In production, Zernio expects a state parameter.
    // We should ideally pass deviceId in the state.
    res.json({ authUrl, deviceId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generic Callback Handler
 * Receives redirect from Zernio and links user account.
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, platform } = req.query;
    const deviceId = state as string; // State contains our deviceId
    const userToken = code as string; // Zernio code/token

    if (deviceId) {
        const user = await User.findOne({ where: { deviceId } });
        if (user) {
            user.zernioUserToken = userToken;
            const platforms = user.connectedPlatforms || [];
            const platformName = platform as string;
            if (platformName && !platforms.includes(platformName)) {
                platforms.push(platformName);
                user.connectedPlatforms = platforms;
            }
            await user.save();
        }
    }

    // Professional Deep Link redirect
    res.redirect(`mistreal://social-connected?platform=${platform || 'unified'}&success=true&deviceId=${deviceId}`);
  } catch (error: any) {
    res.redirect(`mistreal://social-connected?success=false&error=${error.message}`);
  }
});

// === UNIFIED SYNC ROUTE ===
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const user = await User.findOne({ where: { deviceId } });

    if (!user || !user.zernioUserToken) {
        return res.status(200).json({ summary: "CONNECTION_REQUIRED", posts: [], platformUpdates: [] });
    }

    const result = await UnifiedSocialService.syncAllPlatforms(user);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// === DISCONNECT PLATFORM ===
router.post('/disconnect/:platform', async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;
    const { platform } = req.params;
    const user = await User.findOne({ where: { deviceId } });

    if (user) {
        const platforms = user.connectedPlatforms || [];
        user.connectedPlatforms = platforms.filter(p => p.toLowerCase() !== platform.toLowerCase());

        if (user.connectedPlatforms.length === 0) {
            user.zernioUserToken = null;
        }
        await user.save();
    }

    res.json({ success: true, platform, message: `${platform} disconnected` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
