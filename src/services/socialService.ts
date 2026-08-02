import axios from 'axios';

const ZERNIO_API_URL = 'https://api.zernio.com/v1'; // FIXED: Domain corrected to .com

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

export const getSocialSummary = async (userToken: string | null, isPro: boolean = false) => {
    if (!userToken) {
        return {
            summary: "CONNECTION_REQUIRED",
            platformUpdates: [],
            posts: [],
            rawContent: ""
        };
    }

    try {
        const response = await axios.get(`${ZERNIO_API_URL}/inbox`, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });

        let items = response.data.items || [];

        if (!isPro) {
            const allowedFreePlatforms = ['twitter', 'x', 'whatsapp', 'whatsapp_business'];
            items = items.filter((item: any) =>
                allowedFreePlatforms.includes(item.platform.toLowerCase())
            );
        }

        if (items.length === 0) {
            return {
                summary: "Your social feeds are quiet right now.",
                platformUpdates: [],
                posts: [],
                rawContent: ""
            };
        }

        const platformCounts: Record<string, number> = {};
        items.forEach((item: any) => {
            platformCounts[item.platform] = (platformCounts[item.platform] || 0) + 1;
        });

        const platformUpdates = Object.keys(platformCounts).map(platformId => {
            const meta = PLATFORM_REGISTRY[platformId.toLowerCase()] || {
                name: platformId.charAt(0).toUpperCase() + platformId.slice(1),
                icon: '🔗',
                color: '#6B4CFF'
            };

            return {
                platform: platformId,
                count: platformCounts[platformId],
                recentMessage: items.find((i: any) => i.platform === platformId)?.content,
                platformIcon: meta.icon,
                platformColor: meta.color,
                platformDisplayName: meta.name
            };
        });

        const posts = items.map((item: any) => {
            const meta = PLATFORM_REGISTRY[item.platform.toLowerCase()] || {
                name: item.platform,
                icon: '🔗',
                color: '#6B4CFF'
            };

            return {
                id: item.id,
                platform: item.platform,
                author: item.author || 'Unknown',
                content: item.content || '',
                timestamp: item.timestamp || new Date().toISOString(),
                imageUrl: item.image_url || null,
                likes: item.likes,
                comments: item.comments,
                sourceUrl: item.source_url,
                platformIcon: meta.icon,
                platformColor: meta.color,
                platformDisplayName: meta.name
            };
        });

        const rawContent = items.map((item: any) => `[${item.platform}] ${item.author}: ${item.content}`).join('\n');

        return {
            summary: `You have ${items.length} new interactions across ${platformUpdates.length} platforms.`,
            platformUpdates,
            posts,
            rawContent
        };
    } catch (error: any) {
        console.error('Zernio Service Error:', error.response?.data || error.message);
        return { summary: "CONNECTION_ERROR", platformUpdates: [], posts: [], rawContent: "" };
    }
};

export const createConnectSession = async (platform: string) => {
    const apiKey = process.env.ZERNIO_API_KEY;
    if (!apiKey) {
        throw new Error('ZERNIO_API_KEY is missing in backend environment variables');
    }

    const appUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';

    try {
        const response = await axios.post(`${ZERNIO_API_URL}/connect`, {
            platform,
            redirect_url: `${appUrl}/api/social/callback`
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (!response.data || !response.data.url) {
            throw new Error('Zernio API did not return a session URL');
        }

        return response.data.url;
    } catch (error: any) {
        const msg = error.response?.data?.error || error.message;
        console.error('Zernio Connect Error:', msg);
        throw new Error(`Failed to create Zernio session: ${msg}`);
    }
};

export const sendSocialAction = async (userToken: string, action: any) => {
    try {
        const response = await axios.post(`${ZERNIO_API_URL}/actions`, action, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });
        return response.data;
    } catch (error: any) {
        throw new Error('Failed to send social action');
    }
};
