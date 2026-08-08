import { User } from '../models/userModel';
import { getPlatformDefinition, getAvailablePlatformDefinitions } from './socialPlatforms/platformRegistry';
import { TwitterOAuth } from './socialPlatforms/twitterAuth';
import { InstagramOAuth } from './socialPlatforms/instagramAuth';
import { FacebookOAuth, LinkedInOAuth } from './socialPlatforms/socialAuthHandlers';

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
 * 🔄 Unified Post Fetching via Direct OAuth
 * Fetches from each platform's API using stored tokens.
 */
export const getSocialSummary = async (user: User, isPro: boolean = false) => {
    const connectedPlatforms = user.connectedPlatforms || [];
    if (connectedPlatforms.length === 0) {
        return { summary: "CONNECTION_REQUIRED", platformUpdates: [], posts: [], rawContent: "" };
    }

    const allPosts: any[] = [];
    const platformUpdates: any[] = [];

    // Fetch from each platform in parallel for speed
    const fetchPromises = connectedPlatforms.map(async (platform) => {
        let posts: any[] = [];
        const def = getPlatformDefinition(platform);

        try {
            switch (platform.toLowerCase()) {
                case 'twitter':
                case 'x':
                    if (user.twitterAccessToken) {
                        posts = await TwitterOAuth.fetchUserPosts(user.twitterAccessToken);
                    }
                    break;
                case 'instagram':
                    if (user.instagramAccessToken) {
                        posts = await InstagramOAuth.fetchUserPosts(user.instagramAccessToken);
                    }
                    break;
                case 'facebook':
                    if (user.facebookAccessToken) {
                        posts = await FacebookOAuth.fetchUserPosts(user.facebookAccessToken);
                    }
                    break;
                case 'linkedin':
                    if (user.linkedinAccessToken) {
                        posts = await LinkedInOAuth.fetchUserPosts(user.linkedinAccessToken);
                    }
                    break;
            }

            if (posts.length > 0) {
                allPosts.push(...posts);
                platformUpdates.push({
                    platform: platform,
                    count: posts.length,
                    platformIcon: def?.icon || '🔗',
                    platformColor: def?.color || '#888',
                    platformDisplayName: def?.displayName || platform,
                    connected: true
                });
            }
        } catch (error) {
            console.error(`Sync failed for ${platform}:`, error);
        }
    });

    await Promise.all(fetchPromises);

    // Sort all posts by timestamp (newest first)
    allPosts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return {
        summary: allPosts.length > 0
            ? `Unified Intelligence: ${allPosts.length} new signals from ${platformUpdates.length} platforms.`
            : 'Your intelligence feeds are silent.',
        platformUpdates,
        posts: allPosts,
        rawContent: allPosts.slice(0, 10).map((p: any) => `[${p.platform}] ${p.author}: ${p.content}`).join('\n')
    };
};

/**
 * 🔗 Create Connection Session using Direct OAuth
 */
export const createConnectSession = async (platform: string, deviceId: string, callbackUrl: string) => {
    switch (platform.toLowerCase()) {
        case 'twitter':
        case 'x':
            return TwitterOAuth.getAuthUrl(deviceId, callbackUrl);
        case 'instagram':
            return InstagramOAuth.getAuthUrl(deviceId, callbackUrl);
        case 'facebook':
            return FacebookOAuth.getAuthUrl(deviceId, callbackUrl);
        case 'linkedin':
            return LinkedInOAuth.getAuthUrl(deviceId, callbackUrl);
        default:
            throw new Error(`OAuth not implemented for platform: ${platform}`);
    }
};

/**
 * 🚀 Exchange OAuth Code for Token and persist
 */
export const exchangeOAuthCode = async (deviceId: string, platform: string, code: string, callbackUrl: string) => {
    const user = await User.findOne({ where: { deviceId } });
    if (!user) throw new Error('User not found');

    let tokenData: any;
    switch (platform.toLowerCase()) {
        case 'twitter':
        case 'x':
            tokenData = await TwitterOAuth.exchangeCodeForToken(code, callbackUrl);
            user.twitterAccessToken = tokenData.accessToken;
            user.twitterRefreshToken = tokenData.refreshToken;
            break;
        case 'instagram':
            tokenData = await InstagramOAuth.exchangeCodeForToken(code, callbackUrl);
            user.instagramAccessToken = tokenData.accessToken;
            break;
        case 'facebook':
            tokenData = await FacebookOAuth.exchangeCodeForToken(code, callbackUrl);
            user.facebookAccessToken = tokenData.accessToken;
            break;
        case 'linkedin':
            tokenData = await LinkedInOAuth.exchangeCodeForToken(code, callbackUrl);
            user.linkedinAccessToken = tokenData.accessToken;
            break;
        default:
            throw new Error(`Token exchange not implemented for: ${platform}`);
    }

    // Add to connected list
    const connected = user.connectedPlatforms || [];
    if (!connected.includes(platform)) {
        connected.push(platform);
        user.connectedPlatforms = connected;
    }

    await user.save();
};

/**
 * 🚀 Post via platform-specific API
 */
export const sendSocialAction = async (user: User, action: { platform: string, type: string, content: string, targetId?: string }) => {
    // This would be implemented for each platform (e.g. TwitterOAuth.postTweet)
    // For now returning success to keep the flow alive
    return { success: true, message: `Action simulated for ${action.platform}` };
};
