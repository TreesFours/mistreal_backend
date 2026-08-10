import { User } from '../models/userModel';
import { getPlatformDefinition, getAvailablePlatformDefinitions } from './socialPlatforms/platformRegistry';
import { ZernioAdapter } from './socialPlatforms/zernioAdapter';

export const getAvailablePlatforms = async (isPro: boolean) => {
    return getAvailablePlatformDefinitions(isPro).map(def => ({
        id: def.id,
        name: def.displayName,
        icon: def.icon,
        color: def.color,
        isProOnly: def.isProOnly
    }));
};

/**
 * 🔄 Refined Zernio Sync logic
 */
export const getSocialSummary = async (user: User, isPro: boolean = false) => {
    if (!user.zernioProfileId) {
        return { summary: "CONNECTION_REQUIRED", platformUpdates: [], posts: [], rawContent: "" };
    }

    try {
        const items = await ZernioAdapter.fetchInbox(user.zernioProfileId);

        // 🛡️ SECURITY: Log the raw items for debugging (backend only)
        console.log(`📡 [SYNC] Profile ${user.zernioProfileId} retrieved ${items.length} items from Zernio.`);

        const filteredItems = isPro ? items : items.filter((i: any) =>
            ['twitter', 'x', 'whatsapp', 'linkedin', 'facebook', 'discord', 'telegram', 'instagram'].includes((i.platform || '').toLowerCase())
        );

        const platformUpdates = filteredItems.reduce((acc: any[], item: any) => {
            const existing = acc.find((p: any) => p.platform === item.platform);
            if (existing) {
                existing.count++;
            } else {
                const def = getPlatformDefinition(item.platform);
                acc.push({
                    platform: item.platform,
                    count: 1,
                    platformIcon: def?.icon || '🔗',
                    platformColor: def?.color || '#888',
                    platformDisplayName: def?.displayName || item.platform,
                    connected: true
                });
            }
            return acc;
        }, []);

        const posts = filteredItems.map((it: any) => {
            const def = getPlatformDefinition(it.platform);
            return {
                id: it._id,
                platform: it.platform,
                author: it.author?.name || 'Social Contact',
                content: it.content?.text || it.content?.body || '',
                timestamp: it.createdAt,
                sourceUrl: it.source_url || null,
                platformIcon: def?.icon || '🔗',
                platformColor: def?.color || '#888',
                platformDisplayName: def?.displayName || it.platform
            };
        });

        return {
            summary: items.length > 0 ? `Unified Intelligence: ${items.length} new signals.` : 'Your intelligence feeds are silent.',
            platformUpdates,
            posts,
            rawContent: posts.map((p: any) => `[${p.platform}] ${p.author}: ${p.content}`).join('\n')
        };
    } catch (error: any) {
        return { summary: "SYNC_ERROR", platformUpdates: [], posts: [], rawContent: "" };
    }
};

/**
 * 🔗 Headless Zernio Session: Bypasses their dashboard
 */
export const createConnectSession = async (platform: string, deviceId: string, callbackUrl: string) => {
    try {
        const user = await User.findOne({ where: { deviceId } });
        if (!user) throw new Error('User not found');

        if (!user.zernioProfileId) {
            user.zernioProfileId = await ZernioAdapter.getOrCreateProfile(deviceId);
            await user.save();
        }

        // 🛡️ Create URL-safe Base64 state to prevent issues with + and / characters in OAuth providers
        // 🚀 CRITICAL: We also append deviceId directly to the callback URL as a redundant fallback
        const state = Buffer.from(JSON.stringify({ deviceId, platform }))
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        const fallbackCallback = `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}deviceId=${deviceId}&platform=${platform}`;

        // 🛡️ Explicit LinkedIn Scopes to prevent "Auth Denied" due to insufficient permissions
        const scope = platform.toLowerCase() === 'linkedin'
            ? 'r_liteprofile,r_emailaddress,w_member_social'
            : undefined;

        // Use Zernio's auth flow but pass our callbackUrl to return to Mistreal app
        // 🚀 Using the fallbackCallback with redundant deviceId/platform params
        return await ZernioAdapter.getAuthUrl(platform, user.zernioProfileId!, scope, state, fallbackCallback);
    } catch (error: any) {
        throw new Error(`Social connection failed: ${error.message}`);
    }
};

export const exchangeOAuthCode = async (deviceId: string, platform: string, code: string, callbackUrl: string) => {
    // With Zernio, their callback handler handles the code exchange.
    // We just need to ensure the platform is marked as connected in our DB.
    const user = await User.findOne({ where: { deviceId } });
    if (!user) throw new Error('User not found');

    const connected = user.connectedPlatforms || [];
    const normalizedPlatform = platform.toLowerCase();

    if (!connected.map(p => p.toLowerCase()).includes(normalizedPlatform)) {
        connected.push(normalizedPlatform);
        // Force Sequelize to recognize the array change
        user.set('connectedPlatforms', connected);
        user.changed('connectedPlatforms', true);
    }

    // 🛡️ CRITICAL: Ensure Zernio Profile ID mapping is persistent
    if (!user.zernioProfileId) {
        // Re-discover or initialize if missing during the exchange
        user.zernioProfileId = await ZernioAdapter.getOrCreateProfile(deviceId);
    }

    // Explicitly mark as connected for specific platform tokens if needed by other logic
    if (normalizedPlatform === 'linkedin') user.linkedinAccessToken = 'ZERNIO_MANAGED';

    await user.save();
    console.log(`✅ ${normalizedPlatform} persistence confirmed for device ${deviceId}`);
};

export const sendSocialAction = async (user: User, action: { platform: string, type: string, content: string, targetId?: string }) => {
    if (!user.zernioProfileId) throw new Error('Connect your social profile first.');
    return await ZernioAdapter.sendAction(user.zernioProfileId, action.platform, action.content, action.type, action.targetId);
};
