import { Router, Request, Response } from 'express';
import { UnifiedSocialService } from '../services/socialPlatforms/unified';
import { createConnectSession, getAvailablePlatforms, exchangeOAuthCode, sendSocialAction } from '../services/socialService';
import { getPlatformDefinition } from '../services/socialPlatforms/platformRegistry';
import { ZernioAdapter } from '../services/socialPlatforms/zernioAdapter';
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

  const appUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';

  // SPECIAL CASE: WhatsApp Meta Embedded Signup
  if (platform === 'whatsapp') {
    // REDIRECT instead of returning JSON
    return res.redirect(`${appUrl}/api/social/whatsapp/bridge?deviceId=${deviceId}`);
  }

  try {
    const authUrl = await createConnectSession(platform as string, deviceId as string);
    // REDIRECT instead of returning JSON
    res.redirect(authUrl);
  } catch (error: any) {
    console.error(`Failed to create connection for ${platform}:`, error.message);
    res.status(500).send(`Connection System Error: ${error.message}`);
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

/**
 * 🌉 WhatsApp Hosted Bridge
 * This page handles the Meta JS SDK "Embedded Signup" flow.
 */
router.get('/whatsapp/bridge', async (req: Request, res: Response) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).send('Device ID missing');

    try {
        const config = await ZernioAdapter.getWhatsAppSdkConfig();

        if (!config.appId || !config.configId) {
            return res.status(500).send('Bridge Configuration Missing: Please ensure Meta App ID and Config ID are set in Zernio.');
        }

        // Simple HTML bridge to run Meta SDK
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Connect WhatsApp</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f0f2f5; padding: 16px; }
                    .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 100%; }
                    button { background: #25D366; color: white; border: none; padding: 14px 28px; border-radius: 28px; font-weight: bold; cursor: pointer; font-size: 1.1rem; margin-top: 1rem; transition: background 0.3s; width: 100%; }
                    button:active { background: #128C7E; }
                    .loader { border: 4px solid #f3f3f3; border-top: 4px solid #25D366; border-radius: 50%; width: 30px; height: 30px; animation: spin 2s linear infinite; display: none; margin: 10px auto; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2 style="margin-top: 0;">Connect WhatsApp</h2>
                    <p>Link your WhatsApp Business account safely via Meta's secure gateway.</p>
                    <button id="connectBtn">Connect with Meta</button>
                    <div id="loader" class="loader"></div>
                    <p id="status" style="color: #666; font-size: 0.9rem; margin-top: 12px; min-height: 1.2em;"></p>
                </div>

                <div id="fb-root"></div>
                <script>
                    console.log('🚀 Bridge Initializing...');

                    window.fbAsyncInit = function() {
                        console.log('✅ FB SDK Loaded');
                        FB.init({
                            appId: '${config.appId}',
                            cookie: true,
                            xfbml: true,
                            version: 'v21.0'
                        });
                    };

                    (function(d, s, id){
                        var js, fjs = d.getElementsByTagName(s)[0];
                        if (d.getElementById(id)) {return;}
                        js = d.createElement(s); js.id = id;
                        js.src = "https://connect.facebook.net/en_US/sdk.js";
                        fjs.parentNode.insertBefore(js, fjs);
                    }(document, 'script', 'facebook-jssdk'));

                    document.getElementById('connectBtn').onclick = function() {
                        console.log('🔘 Button Clicked');
                        const btn = this;
                        const loader = document.getElementById('loader');
                        const status = document.getElementById('status');

                        btn.style.display = 'none';
                        loader.style.display = 'block';
                        status.innerText = 'Initializing Meta Secure Login...';

                        try {
                            FB.login(function(response) {
                                console.log('👤 FB Login Response:', response);
                                if (response.authResponse) {
                                    const code = response.authResponse.code;
                                    status.innerText = 'Secure Code Received! Redirecting...';
                                    window.location.href = '/api/social/whatsapp/callback?code=' + code + '&deviceId=${deviceId}';
                                } else {
                                    console.warn('❌ Login Cancelled or Failed');
                                    status.innerText = 'Connection cancelled or failed.';
                                    btn.style.display = 'block';
                                    loader.style.display = 'none';
                                }
                            }, {
                                scope: 'whatsapp_business_management,whatsapp_business_messaging',
                                extras: {
                                    feature: 'whatsapp_embedded_signup',
                                    config_id: '${config.configId}'
                                }
                            });
                        } catch (err) {
                            console.error('🔥 FB Login Error:', err);
                            status.innerText = 'SDK Error: ' + err.message;
                            btn.style.display = 'block';
                            loader.style.display = 'none';
                        }
                    };
                </script>
            </body>
            </html>
        `;
        res.send(html);
    } catch (error: any) {
        res.status(500).send('Bridge Initialization Failed: ' + error.message);
    }
});

/**
 * 🏁 WhatsApp Bridge Callback
 */
router.get('/whatsapp/callback', async (req: Request, res: Response) => {
    const { code, deviceId } = req.query;
    if (!code || !deviceId) return res.redirect('mistreal://social-connected?success=false&error=Missing code or deviceId');

    try {
        const result = await ZernioAdapter.completeWhatsAppSignup(code as string);
        const user = await User.findOne({ where: { deviceId: deviceId as string } });

        if (user) {
            user.whatsappAccessToken = result.accessToken;
            user.whatsappWabaId = result.wabaId;
            user.whatsappPhoneId = result.phoneNumberId;

            // Store platform canonical ID
            const platforms = user.connectedPlatforms || [];
            if (!platforms.includes('whatsapp')) {
                platforms.push('whatsapp');
                user.connectedPlatforms = platforms;
            }
            await user.save();
        }

        res.redirect(`mistreal://social-connected?platform=whatsapp&success=true&deviceId=${deviceId}`);
    } catch (error: any) {
        res.redirect(`mistreal://social-connected?platform=whatsapp&success=false&error=${encodeURIComponent(error.message)}&deviceId=${deviceId}`);
    }
});

router.post('/action', async (req: Request, res: Response) => {
  try {
    const { deviceId, platform, type, content, targetId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
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
