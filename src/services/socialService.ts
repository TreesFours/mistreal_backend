import { User, SocialEvent } from '../models/userModel';
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
    try {
        // 💾 PERSISTENCE FIRST: Fetch from our DB
        const events = await SocialEvent.findAll({
            where: { deviceId: user.deviceId },
            order: [['timestamp', 'DESC']],
            limit: 50
        });

        let items = events.map(e => ({
            _id: e.externalId,
            platform: e.platform,
            author: { id: e.senderId, name: e.senderName },
            content: { text: e.content },
            createdAt: e.timestamp,
            metadata: e.metadata,
            type: e.type
        }));

        // 🚰 HYDRATION: If DB is empty, do a one-time sync from Zernio
        if (items.length === 0 && user.zernioProfileId) {
            console.info(`🚰 [SYNC] DB empty. Hydrating from Zernio Inbox & Feed for Profile: ${user.zernioProfileId}`);
            try {
                // Fetch both DMs (Inbox) AND Social Posts (Feed)
                const [inboxItems, feedItems] = await Promise.all([
                    ZernioAdapter.fetchInbox(user.zernioProfileId),
                    ZernioAdapter.fetchFeed(user.zernioProfileId)
                ]);

                const allRemoteItems = [...inboxItems, ...feedItems];
                console.info(`📥 [SYNC] Zernio returned ${inboxItems.length} Inbox items and ${feedItems.length} Feed items.`);

                for (const it of allRemoteItems) {
                    await SocialEvent.findOrCreate({
                        where: { externalId: it._id || it.id },
                        defaults: {
                            deviceId: user.deviceId,
                            platform: it.platform.toLowerCase(),
                            type: it.type || (feedItems.includes(it) ? 'post' : 'message'),
                            externalId: it._id || it.id,
                            senderId: it.author?.id,
                            senderName: it.author?.name || it.author?.handle || 'Social Contact',
                            content: it.content?.text || it.content?.body || "",
                            metadata: it.metadata || {},
                            timestamp: it.createdAt || new Date()
                        }
                    });
                }
                items = allRemoteItems;
            } catch (fetchError: any) {
                console.error(`❌ [SYNC] Zernio Fetch Failed: ${fetchError.message}`);
            }
        }

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
