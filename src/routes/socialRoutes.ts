import { Router, Request, Response } from 'express';
import { UnifiedSocialService } from '../services/socialPlatforms/unified';
import { createConnectSession, getAvailablePlatforms, exchangeOAuthCode, sendSocialAction } from '../services/socialService';
import { getPlatformDefinition } from '../services/socialPlatforms/platformRegistry';
import { ZernioAdapter } from '../services/socialPlatforms/zernioAdapter';
import { User } from '../models/userModel';

const router = Router();
...
// 🛡️ Internal Helper
...
// 📱 Get Available Platforms (RESTORED HERE)
...
// === PROFESSIONAL DIRECT OAUTH ROUTES ===
router.get('/connect/:platform', async (req: Request, res: Response) => {
  const { platform } = req.params;
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

  // SPECIAL CASE: WhatsApp Meta Embedded Signup
  if (platform === 'whatsapp') {
    const appUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
    return res.json({
        authUrl: `${appUrl}/api/social/whatsapp/bridge?deviceId=${deviceId}`,
        deviceId
    });
  }

  try {
    const authUrl = await createConnectSession(platform as string, deviceId as string);
    res.json({ authUrl, deviceId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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

        // Simple HTML bridge to run Meta SDK
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Connect WhatsApp</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f0f2f5; }
                    .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
                    button { background: #25D366; color: white; border: none; padding: 12px 24px; border-radius: 24px; font-weight: bold; cursor: pointer; font-size: 1rem; margin-top: 1rem; }
                    .loader { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 30px; height: 30px; animation: spin 2s linear infinite; display: none; margin: 10px auto; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>Connect WhatsApp</h2>
                    <p>Click the button below to link your WhatsApp Business account via Meta.</p>
                    <button id="connectBtn">Connect with Meta</button>
                    <div id="loader" class="loader"></div>
                    <p id="status" style="color: #666; font-size: 0.9rem;"></p>
                </div>

                <script>
                    window.fbAsyncInit = function() {
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
                        this.style.display = 'none';
                        document.getElementById('loader').style.display = 'block';
                        document.getElementById('status').innerText = 'Opening Meta secure popup...';

                        FB.login(function(response) {
                            if (response.authResponse) {
                                const code = response.authResponse.code;
                                document.getElementById('status').innerText = 'Securing connection with Mistreal...';
                                // Send code to our callback
                                window.location.href = '/api/social/whatsapp/callback?code=' + code + '&deviceId=${deviceId}';
                            } else {
                                document.getElementById('status').innerText = 'Connection cancelled by user.';
                                document.getElementById('connectBtn').style.display = 'inline-block';
                                document.getElementById('loader').style.display = 'none';
                            }
                        }, {
                            scope: 'whatsapp_business_management,whatsapp_business_messaging',
                            extras: {
                                feature: 'whatsapp_embedded_signup',
                                config_id: '${config.configId}'
                            }
                        });
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
...

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
