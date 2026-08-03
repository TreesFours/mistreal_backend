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
 * 🔄 Official Zernio Sync logic
 * Now uses the Profile ID to fetch a Unified Inbox.
 */
export const getSocialSummary = async (user: User, isPro: boolean = false) => {
    if (!user.zernioProfileId) {
        return { summary: "CONNECTION_REQUIRED", platformUpdates: [], posts: [], rawContent: "" };
    }

    try {
        const items = await ZernioAdapter.fetchInbox(user.zernioProfileId);

        // Filter based on tier if necessary
        const filteredItems = isPro ? items : items.filter((i: any) =>
            ['twitter', 'x', 'whatsapp'].includes(i.platform.toLowerCase())
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

        const posts = filteredItems.map((it: any) => ({
            id: it._id,
            platform: it.platform,
            author: it.author?.name || 'Social Contact',
            content: it.content?.text || it.content?.body || '',
            timestamp: it.createdAt,
            sourceUrl: null
        }));

        return {
            summary: items.length > 0 ? `Unified Intelligence: ${items.length} new signals.` : 'Your intelligence feeds are silent.',
            platformUpdates,
            posts,
            rawContent: posts.map(p => `[${p.platform}] ${p.author}: ${p.content}`).join('\n')
        };
    } catch (error: any) {
        return { summary: "SYNC_ERROR", platformUpdates: [], posts: [], rawContent: "" };
    }
};

/**
 * 🔗 Step 1 & 2 combined: Create Profile and Get Redirect
 */
export const createConnectSession = async (platform: string, deviceId: string) => {
    try {
        // Find user
        const user = await User.findOne({ where: { deviceId } });
        if (!user) throw new Error('User not found');

        // 1. Ensure Profile exists in Zernio
        if (!user.zernioProfileId) {
            user.zernioProfileId = await ZernioAdapter.getOrCreateProfile(deviceId);
            await user.save();
        }

        // 2. Get the redirect URL
        return await ZernioAdapter.getAuthUrl(platform, user.zernioProfileId);
    } catch (error: any) {
        throw new Error(`Social connection failed: ${error.message}`);
    }
};

/**
 * 🚀 Post via Zernio Unified Posts API
 */
export const sendSocialAction = async (user: User, action: { platform: string, type: string, content: string, targetId?: string }) => {
    if (!user.zernioProfileId) throw new Error('Connect your social profile first.');

    try {
        const result = await ZernioAdapter.sendAction(user.zernioProfileId, action.platform, action.content, action.type);
        return { success: true, data: result };
    } catch (error: any) {
        throw new Error(`Dispatch failed: ${error.message}`);
    }
};
