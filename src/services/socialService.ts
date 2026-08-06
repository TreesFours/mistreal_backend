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

        // 2. Resolve Scope: Handle platform-specific User/Bot mode ambiguity
        // Discord is the primary one where users often get 'Bot Invite' by mistake.
        // For others like Instagram/Twitter, Zernio's defaults are optimized for User data.
        const platformScopes: Record<string, string> = {
            'discord': 'identify guilds', // Switches to 'User OAuth' mode
            'twitter': 'tweet.read users.read offline.access',
            'instagram': 'instagram_basic instagram_manage_messages',
            'facebook': 'pages_show_list pages_messaging',
        };

        const scope = platformScopes[platform.toLowerCase()];

        // 3. Get the redirect URL
        return await ZernioAdapter.getAuthUrl(platform, user.zernioProfileId!, scope);
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
