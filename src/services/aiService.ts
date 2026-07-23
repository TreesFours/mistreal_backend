import axios from 'axios';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE_AI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export const getAvailableModels = async (isPro: boolean) => {
    const geminiKey = process.env.GEMINI_API;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    let models: { id: string, name: string, provider: string, isProOnly: boolean, price: string }[] = [];

    // 1. FREE TIER: Strictly Gemini Models (Direct Google API)
    if (geminiKey) {
        try {
            const response = await axios.get(`${GOOGLE_AI_URL}?key=${geminiKey}`);
            if (response.data && response.data.models) {
                const geminiModels = response.data.models
                    .filter((m: any) => m.supportedGenerationMethods.includes('generateContent'))
                    .map((m: any) => ({
                        id: m.name.replace('models/', ''),
                        name: m.displayName,
                        provider: 'google',
                        isProOnly: false,
                        price: 'Free'
                    }));
                models = [...models, ...geminiModels];
            }
        } catch (error) {
            console.error('Error fetching Gemini models:', error);
        }
    }

    // 2. PREMIUM TIER: Strictly OpenRouter Models
    // We fetch them even if not pro so the user can see the options in the Premium list
    if (openRouterKey) {
        try {
            const response = await axios.get('https://openrouter.ai/api/v1/models');
            if (response.data && response.data.data) {
                const premiumModels = response.data.data
                    .filter((m: any) => m.id.includes('claude') || m.id.includes('gpt-4') || m.id.includes('llama-3'))
                    .map((m: any) => ({
                        id: m.id,
                        name: m.name,
                        provider: 'openrouter',
                        isProOnly: true,
                        price: 'PRO'
                    }));
                models = [...models, ...premiumModels];
            }
        } catch (error) {
            console.error('Error fetching OpenRouter models:', error);
        }
    }

    // Fallback if nothing found
    if (models.length === 0) {
        models = [
            { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'google', isProOnly: false, price: 'Free' },
            { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo (PRO)', provider: 'openrouter', isProOnly: true, price: 'PRO' }
        ];
    }

    return models;
};

export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any) => {
    const geminiKey = process.env.GEMINI_API;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    // 1. Check if it's a Gemini model (Google Direct)
    const isGoogleModel = !provider.includes('/');

    if (isGoogleModel && geminiKey) {
        console.log(`🤖 Using Direct Google Gemini API: ${provider}`);
        try {
            const response = await axios.post(
                `${GOOGLE_AI_URL}/${provider}:generateContent?key=${geminiKey}`,
                {
                    contents: [{
                        parts: [{ text: prompt }]
                    }]
                }
            );

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                return {
                    content: response.data.candidates[0].content.parts[0].text,
                    provider: provider,
                    success: true
                };
            }
            throw new Error('Gemini returned an empty response');
        } catch (error: any) {
            console.error('❌ Direct Gemini Error:', error.response?.data || error.message);
            return {
                content: '',
                provider: provider,
                success: false,
                error: `Gemini Error: ${error.message}`
            };
        }
    }

    // 2. Otherwise use OpenRouter
    if (!openRouterKey) {
        return { success: false, error: "OpenRouter API key missing" };
    }

    console.log(`🤖 Using OpenRouter for: ${provider}`);
    try {
        const response = await axios.post(
            OPENROUTER_API_URL,
            {
                model: provider,
                messages: [
                    ...history.map((m: any) => ({ role: m.role, content: m.content })),
                    { role: 'user', content: prompt }
                ]
            },
            {
                headers: {
                    'Authorization': `Bearer ${openRouterKey}`,
                    'HTTP-Referer': 'https://mistreal-assistant.com',
                    'X-Title': 'Mistreal Assistant'
                }
            }
        );

        if (!response.data || !response.data.choices || response.data.choices.length === 0) {
            throw new Error('OpenRouter returned an empty response');
        }

        return {
            content: response.data.choices[0].message.content,
            provider: provider,
            success: true
        };
    } catch (error: any) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        console.error('❌ OpenRouter Error:', errorMessage);
        return {
            content: '',
            provider: provider,
            success: false,
            error: `OpenRouter Error: ${errorMessage}`
        };
    }
};
