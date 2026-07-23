import axios from 'axios';

const ZERNIO_API_URL = 'https://api.zerion.com/v1';

export const getAvailablePlatforms = async (isPro: boolean) => {
    const allPlatforms = [
        { id: 'twitter', name: 'X (Twitter)', icon: 'public' },
        { id: 'whatsapp_business', name: 'WhatsApp', icon: 'chat' },
        { id: 'instagram', name: 'Instagram', icon: 'camera_alt' },
        { id: 'linkedin', name: 'LinkedIn', icon: 'work' },
        { id: 'threads', name: 'Threads', icon: 'alternate_email' },
        { id: 'discord', name: 'Discord', icon: 'discord' }
    ];

    return allPlatforms.map((p, index) => ({
        ...p,
        isProOnly: index > 1 // Twitter & WhatsApp are Free
    }));
};

export const getSocialSummary = async (userToken: string | null) => {
    if (!userToken) {
        return {
            summary: "CONNECTION_REQUIRED",
            platformUpdates: [],
            rawContent: ""
        };
    }

    try {
        const response = await axios.get(`${ZERNIO_API_URL}/inbox`, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });

        const items = response.data.items || [];
        if (items.length === 0) {
            return {
                summary: "Your social feeds are quiet right now.",
                platformUpdates: [],
                rawContent: ""
            };
        }

        const platformCounts: Record<string, number> = {};
        items.forEach((item: any) => {
            platformCounts[item.platform] = (platformCounts[item.platform] || 0) + 1;
        });

        const platformUpdates = Object.keys(platformCounts).map(platform => ({
            platform,
            count: platformCounts[platform],
            recentMessage: items.find((i: any) => i.platform === platform)?.content
        }));

        const rawContent = items.map((item: any) => `[${item.platform}] ${item.author}: ${item.content}`).join('\n');

        return {
            summary: `You have ${items.interactionCount || items.length} new interactions.`,
            platformUpdates,
            rawContent
        };
    } catch (error: any) {
        console.error('Zernio Service Error:', error.response?.data || error.message);
        return { summary: "CONNECTION_ERROR", platformUpdates: [], rawContent: "" };
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
