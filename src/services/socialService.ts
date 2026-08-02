import { User } from '../models/userModel';
import { getPlatformDefinition, getAvailablePlatformDefinitions } from './socialPlatforms/platformRegistry';

export const getAvailablePlatforms = async (isPro: boolean) => {
    return getAvailablePlatformDefinitions(isPro).map(def => ({
        id: def.id,
        name: def.displayName,
        icon: def.icon,
        color: def.color,
        isProOnly: def.isProOnly
    }));
};

export const getSocialSummary = async (user: User, isPro: boolean = false) => {
    const posts: any[] = [];
    const platformUpdates: Record<string, any> = {};

    try {
        const connectedPlatforms = user.connectedPlatforms || [];
        const platformDefinitions = connectedPlatforms
            .map(platformId => getPlatformDefinition(platformId))
            .filter(Boolean) as any[];

        for (const definition of platformDefinitions) {
            try {
                const tokenField = definition.tokenField;
                if (!tokenField) continue;

                const accessToken = (user as any)[tokenField];
                if (!accessToken) continue;

                if (!definition.fetchContent) continue;

                const platformPosts = await definition.fetchContent(user);
                posts.push(...platformPosts);
                platformUpdates[definition.id] = {
                    platform: definition.id,
                    count: platformPosts.length,
                    platformIcon: definition.icon,
                    platformColor: definition.color,
                    platformDisplayName: definition.displayName,
                    connected: true
                };
            } catch (error: any) {
                console.error(`Failed to fetch posts for ${definition.id}:`, error.message || error);
            }
        }

        // Sort by timestamp
        posts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        const rawContent = posts
            .map(p => `[${p.platform}] ${p.author}: ${p.content}`)
            .join('\n');

        return {
            summary: posts.length > 0
                ? `Synced ${posts.length} posts from ${Object.keys(platformUpdates).length} platforms`
                : 'No connected platforms or no new posts',
            platformUpdates: Object.values(platformUpdates),
            posts,
            rawContent
        };
    } catch (error: any) {
        console.error('Social sync error:', error.message);
        return {
            summary: 'Failed to sync socials. Try reconnecting.',
            platformUpdates: [],
            posts: [],
            rawContent: ''
        };
    }
};

export const createConnectSession = async (platform: string, deviceId: string) => {
    const appUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
    const callbackUrl = `${appUrl}/api/social/callback`;

    try {
        const definition = getPlatformDefinition(platform);
        if (!definition) {
            throw new Error(`Platform ${platform} not supported`);
        }

        const authUrl = definition.getAuthUrl(deviceId, callbackUrl);
        return authUrl;
    } catch (error: any) {
        console.error(`Failed to create OAuth session for ${platform}:`, error.message);
        throw new Error(`Failed to create ${platform} auth session: ${error.message}`);
    }
};

export const exchangeOAuthCode = async (platform: string, code: string): Promise<any> => {
    const appUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
    const callbackUrl = `${appUrl}/api/social/callback`;

    try {
        const definition = getPlatformDefinition(platform);
        if (!definition) {
            throw new Error(`Platform ${platform} not supported`);
        }

        const token = await definition.exchangeCodeForToken(code, callbackUrl);
        return token;
    } catch (error: any) {
        console.error(`Failed to exchange OAuth code for ${platform}:`, error.message);
        throw error;
    }
};

export const sendSocialAction = async (userToken: string, action: any) => {
    try {
        // Implement based on specific platform actions
        // For now, return a placeholder
        return { success: true, message: 'Action queued' };
    } catch (error: any) {
        throw new Error('Failed to send social action');
    }
};
