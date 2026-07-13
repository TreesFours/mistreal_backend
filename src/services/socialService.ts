import axios from 'axios';

const ZERNIO_API_URL = 'https://api.zernio.com/v1';

export const getSocialSummary = async () => {
    const apiKey = process.env.ZERNIO_API_KEY;

    try {
        // Fetch recent messages and comments from Zernio (Unified API)
        const response = await axios.get(`${ZERNIO_API_URL}/inbox`, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        const items = response.data.items || [];

        // Return a structured summary for the AI to process
        return {
            summary: `You have ${items.length} new interactions across your social accounts.`,
            platformUpdates: items.map((item: any) => ({
                platform: item.platform,
                count: 1, // Zernio returns individual items
                recentMessage: item.content
            })),
            rawContent: items.map((item: any) => `${item.platform}: ${item.content}`).join('\n')
        };
    } catch (error: any) {
        console.error('Social Service Error:', error.message);
        return {
            summary: "Unable to sync socials right now.",
            platformUpdates: [],
            rawContent: ""
        };
    }
};
