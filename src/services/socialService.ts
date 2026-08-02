import axios from 'axios';
import { TwitterOAuth } from './socialPlatforms/twitterAuth';
import { InstagramOAuth } from './socialPlatforms/instagramAuth';
import { WhatsAppOAuth } from './socialPlatforms/whatsappAuth';
import { FacebookOAuth, LinkedInOAuth } from './socialPlatforms/socialAuthHandlers';
import { User } from '../models/userModel';

/**
 * Professional Platform Registry (Backend-Only)
 */
const PLATFORM_REGISTRY: Record<string, { name: string, icon: string, color: string }> = {
    'twitter': { name: 'X (Twitter)', icon: '🐦', color: '#1DA1F2' },
    'x': { name: 'X (Twitter)', icon: '🐦', color: '#1DA1F2' },
    'whatsapp_business': { name: 'WhatsApp', icon: '💬', color: '#25D366' },
    'whatsapp': { name: 'WhatsApp', icon: '💬', color: '#25D366' },
    'instagram': { name: 'Instagram', icon: '📷', color: '#E4405F' },
    'facebook': { name: 'Facebook', icon: 'f', color: '#1877F2' },
    'telegram': { name: 'Telegram', icon: '🤖', color: '#0088cc' },
    'reddit': { name: 'Reddit', icon: 'r/', color: '#FF4500' },
    'linkedin': { name: 'LinkedIn', icon: 'in', color: '#0A66C2' }
};

const OAUTH_HANDLERS: Record<string, any> = {
    'twitter': TwitterOAuth,
    'x': TwitterOAuth,
    'instagram': InstagramOAuth,
    'whatsapp': WhatsAppOAuth,
    'whatsapp_business': WhatsAppOAuth,
    'facebook': FacebookOAuth,
    'linkedin': LinkedInOAuth
};

export const getAvailablePlatforms = async (isPro: boolean) => {
    const allPlatforms = Object.entries(PLATFORM_REGISTRY).map(([id, meta]) => ({
        id,
        name: meta.name,
        icon: meta.icon,
        isProOnly: !['twitter', 'whatsapp_business', 'x', 'whatsapp'].includes(id)
    }));

    if (isPro) return allPlatforms;
    return allPlatforms.filter(p => !p.isProOnly);
};

export const getSocialSummary = async (user: User, isPro: boolean = false) => {
    const posts: any[] = [];
    const platformUpdates: Record<string, any> = {};

    try {
        // Fetch from each connected platform
        if (user.twitterAccessToken) {
            try {
                const twitterPosts = await TwitterOAuth.fetchUserPosts(user.twitterAccessToken);
                posts.push(...twitterPosts);
                platformUpdates['twitter'] = {
                    platform: 'twitter',
                    count: twitterPosts.length,
                    platformIcon: '🐦',
                    platformColor: '#1DA1F2',
                    platformDisplayName: 'X (Twitter)',
                    connected: true
                };
            } catch (error) {
                console.error('Twitter fetch error:', error);
            }
        }

        if (user.instagramAccessToken) {
            try {
                const instaPosts = await InstagramOAuth.fetchUserPosts(user.instagramAccessToken);
                posts.push(...instaPosts);
                platformUpdates['instagram'] = {
                    platform: 'instagram',
                    count: instaPosts.length,
                    platformIcon: '📷',
                    platformColor: '#E4405F',
                    platformDisplayName: 'Instagram',
                    connected: true
                };
            } catch (error) {
                console.error('Instagram fetch error:', error);
            }
        }

        if (user.facebookAccessToken) {
            try {
                const fbPosts = await FacebookOAuth.fetchUserPosts(user.facebookAccessToken);
                posts.push(...fbPosts);
                platformUpdates['facebook'] = {
                    platform: 'facebook',
                    count: fbPosts.length,
                    platformIcon: 'f',
                    platformColor: '#1877F2',
                    platformDisplayName: 'Facebook',
                    connected: true
                };
            } catch (error) {
                console.error('Facebook fetch error:', error);
            }
        }

        if (user.linkedinAccessToken) {
            try {
                const liPosts = await LinkedInOAuth.fetchUserPosts(user.linkedinAccessToken);
                posts.push(...liPosts);
                platformUpdates['linkedin'] = {
                    platform: 'linkedin',
                    count: liPosts.length,
                    platformIcon: 'in',
                    platformColor: '#0A66C2',
                    platformDisplayName: 'LinkedIn',
                    connected: true
                };
            } catch (error) {
                console.error('LinkedIn fetch error:', error);
            }
        }

        // Filter by free tier
        if (!isPro) {
            const allowedFreePlatforms = ['twitter', 'x', 'whatsapp', 'whatsapp_business'];
            posts.filter(p => allowedFreePlatforms.includes(p.platform.toLowerCase()));
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
        const handler = OAUTH_HANDLERS[platform.toLowerCase()];
        if (!handler) {
            throw new Error(`Platform ${platform} not supported`);
        }

        const authUrl = handler.getAuthUrl(deviceId, callbackUrl);
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
        const handler = OAUTH_HANDLERS[platform.toLowerCase()];
        if (!handler) {
            throw new Error(`Platform ${platform} not supported`);
        }

        const token = await handler.exchangeCodeForToken(code, callbackUrl);
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
