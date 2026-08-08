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
        const filteredItems = isPro ? items : items.filter((i: any) =>
            ['twitter', 'x', 'whatsapp', 'linkedin', 'discord'].includes(i.platform.toLowerCase())
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

        const state = Buffer.from(JSON.stringify({ deviceId, platform })).toString('base64');

        // Use Zernio's auth flow but pass our callbackUrl to return to Mistreal app
        return await ZernioAdapter.getAuthUrl(platform, user.zernioProfileId!, undefined, state);
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
    if (!connected.includes(platform)) {
        connected.push(platform);
        user.connectedPlatforms = connected;
    }
    await user.save();
};

export const sendSocialAction = async (user: User, action: { platform: string, type: string, content: string, targetId?: string }) => {
    if (!user.zernioProfileId) throw new Error('Connect your social profile first.');
    return await ZernioAdapter.sendAction(user.zernioProfileId, action.platform, action.content, action.type);
};
