import { Router, Request, Response } from 'express';
import { Business } from '../models/businessModel';
import { User } from '../models/userModel';
import { ZernioAdapter } from '../services/socialPlatforms/zernioAdapter';
import { normalizePlatformId } from '../utils/platformId';
import logger from '../utils/logger';

/**
 * Zernio Ads integration — structurally mirrors socialRoutes.ts's real
 * OAuth connect/callback shape (NOT the BYOK single-key-on-User pattern
 * used for voice cloning/video edit), since an ad-account connection is a
 * per-platform external grant, same shape as a social profile connection.
 *
 * Honest flag, not just in the plan doc: every route below can compile and
 * still do nothing real until (1) a real ad account is connected per
 * platform through /connect+/callback, and (2) Zernio's own "Ads add-on"
 * is enabled on this workspace. Neither is verifiable from this sandbox —
 * routes surface Zernio's real ads_addon_required error verbatim so the
 * user finds out which is missing from the UI itself, not a guess here.
 */
const router = Router();

router.post('/connect', async (req: Request, res: Response) => {
    try {
        const { deviceId, businessId, platform } = req.body;
        if (!deviceId || !businessId || !platform) {
            return res.status(200).json({ success: false, error: 'deviceId, businessId and platform are required' });
        }

        const business = await Business.findOne({ where: { businessId, ownerDeviceId: deviceId } });
        if (!business) {
            return res.status(200).json({ success: false, error: 'Business not found for this device' });
        }

        const user = await User.findOne({ where: { deviceId } });
        if (!user?.zernioProfileId) {
            return res.status(200).json({ success: false, error: 'Connect a social platform first — an ad account needs an existing Zernio profile.' });
        }

        const normPlatform = normalizePlatformId(platform);
        const state = Buffer.from(JSON.stringify({ deviceId, businessId, platform: normPlatform }))
            .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
        const authUrl = await ZernioAdapter.getAdsConnectAuthUrl(normPlatform, user.zernioProfileId, state, `${baseUrl}/api/ad-campaigns/callback`);
        res.json({ success: true, connectUrl: authUrl });
    } catch (e: any) {
        logger.error(`❌ POST /ads/connect error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/callback', async (req: Request, res: Response) => {
    try {
        const { state, adAccountId } = req.query;
        if (!state) return res.status(400).send('Invalid callback — missing state');

        const normalizedState = (state as string).replace(/-/g, '+').replace(/_/g, '/');
        const decoded = JSON.parse(Buffer.from(normalizedState, 'base64').toString('utf8'));
        const { deviceId, businessId, platform } = decoded;

        const business = await Business.findOne({ where: { businessId, ownerDeviceId: deviceId } });
        if (!business) return res.status(400).send('Business not found');

        const existing: { platform: string; adAccountId: string }[] = business.connectedAdAccounts || [];
        const filtered = existing.filter(a => a.platform !== platform);
        business.connectedAdAccounts = [...filtered, { platform, adAccountId: String(adAccountId || '') }];
        await business.save();

        res.redirect(`mistreal://ads-connected?platform=${platform}&success=true`);
    } catch (e: any) {
        logger.error(`❌ GET /ads/callback error: ${e.message}`);
        res.redirect(`mistreal://ads-connected?success=false&error=${encodeURIComponent(e.message)}`);
    }
});

router.post('/campaigns', async (req: Request, res: Response) => {
    try {
        const { deviceId, businessId, platform, ...campaign } = req.body;
        if (!deviceId || !businessId || !platform) {
            return res.status(200).json({ success: false, error: 'deviceId, businessId and platform are required' });
        }

        const business = await Business.findOne({ where: { businessId, ownerDeviceId: deviceId } });
        if (!business) return res.status(200).json({ success: false, error: 'Business not found for this device' });

        const adAccount = (business.connectedAdAccounts || []).find(a => a.platform === normalizePlatformId(platform));
        if (!adAccount) return res.status(200).json({ success: false, error: `No connected ad account for ${platform} — connect one first.` });

        const result = await ZernioAdapter.createAdCampaign(adAccount.adAccountId, campaign);
        res.json({ success: true, campaign: result });
    } catch (e: any) {
        logger.error(`❌ POST /ads/campaigns error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.put('/campaigns/:id', async (req: Request, res: Response) => {
    try {
        const result = await ZernioAdapter.updateAdCampaign(req.params.id, req.body);
        res.json({ success: true, campaign: result });
    } catch (e: any) {
        logger.error(`❌ PUT /ads/campaigns/${req.params.id} error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.delete('/campaigns/:id', async (req: Request, res: Response) => {
    try {
        await ZernioAdapter.deleteAdCampaign(req.params.id);
        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ DELETE /ads/campaigns/${req.params.id} error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/campaigns', async (req: Request, res: Response) => {
    try {
        const { deviceId, businessId, platform } = req.query;
        if (!deviceId || !businessId || !platform) {
            return res.status(200).json({ success: false, campaigns: [], error: 'deviceId, businessId and platform are required' });
        }

        const business = await Business.findOne({ where: { businessId, ownerDeviceId: deviceId } });
        if (!business) return res.status(200).json({ success: false, campaigns: [], error: 'Business not found for this device' });

        const adAccount = (business.connectedAdAccounts || []).find(a => a.platform === normalizePlatformId(String(platform)));
        if (!adAccount) return res.status(200).json({ success: false, campaigns: [], error: `No connected ad account for ${platform}` });

        const campaigns = await ZernioAdapter.listAdCampaigns(adAccount.adAccountId);
        res.json({ success: true, campaigns });
    } catch (e: any) {
        logger.error(`❌ GET /ads/campaigns error: ${e.message}`);
        res.status(200).json({ success: false, campaigns: [], error: e.message });
    }
});

router.get('/campaigns/:id/analytics', async (req: Request, res: Response) => {
    try {
        const analytics = await ZernioAdapter.getAdCampaignAnalytics(req.params.id);
        res.json({ success: true, analytics });
    } catch (e: any) {
        logger.error(`❌ GET /ads/campaigns/${req.params.id}/analytics error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
