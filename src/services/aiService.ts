import axios from 'axios';
import logger from '../utils/logger';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE_AI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const FAILURE_THRESHOLD = 3;

// 📦 Professional Multipart File Handlers
export const extractImageData = (file: Express.Multer.File): string => {
    return file.buffer.toString('base64');
};

export const extractAudioData = (file: Express.Multer.File): string => {
    return file.buffer.toString('base64');
};
const BREAKER_COOLDOWN_MS = 60000;
const REQUEST_TIMEOUT_MS = 15000;

let openRouterFailures = 0;
let lastOpenRouterFailure = 0;

const isOpenRouterBreakerTripped = () => {
    if (openRouterFailures >= FAILURE_THRESHOLD) {
        const now = Date.now();
        if (now - lastOpenRouterFailure < BREAKER_COOLDOWN_MS) return true;
        openRouterFailures = 0;
    }
    return false;
};

export const getAvailableModels = async (isPro: boolean) => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    let models: { id: string, name: string, provider: string, isProOnly: boolean, price: string }[] = [];

    // 1. FREE TIER: Strictly Gemini Models (Direct Google API)
    if (geminiKey) {
        try {
            const response = await axios.get(`${GOOGLE_AI_URL}?key=${geminiKey}`);
            if (response.data && response.data.models) {
                const geminiModels = response.data.models
                    .filter((m: any) => m.supportedGenerationMethods.includes('generateContent'))
                    .map((m: any) => {
                        const id = m.name.replace('models/', '');
                        // Strictly limit Free tier to Flash/low-cost models
                        const isPro = id.includes('pro') || id.includes('ultra');
                        return {
                            id: id,
                            name: m.displayName,
                            provider: 'google',
                            isProOnly: isPro,
                            price: isPro ? 'PRO' : 'Free'
                        };
                    });
                models = [...models, ...geminiModels];
            }
        } catch (error) {
            console.error('Error fetching Gemini models:', error);
        }
    }

    // 2. PREMIUM TIER: Strictly OpenRouter Models
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

                // Only return full list if user is Pro
                if (isPro) {
                    models = [...models, ...premiumModels];
                } else {
                    // Return only top 3 as "Teasers"
                    models = [...models, ...premiumModels.slice(0, 3)];
                }
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

export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any, imageDatas?: string[], audioData?: string) => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    // 1. Check if it's a Gemini model (Google Direct)
    const isGoogleModel = !provider.includes('/');
    let activeProvider = provider;

    // Circuit Breaker: If OpenRouter is failing, force Gemini Flash fallback
    if (!isGoogleModel && isOpenRouterBreakerTripped()) {
        logger.warn(`⚠️ OpenRouter breaker TRIPPED. Falling back to Gemini Flash for stability.`);
        activeProvider = 'gemini-1.5-flash';
    }

    if (activeProvider.startsWith('gemini') && !activeProvider.includes('/') && geminiKey) {
        logger.info(`🤖 Using Direct Google Gemini API: ${activeProvider}`);
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            // Map history to Gemini's format (user/model roles)
            const contents = history.map((m: any) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }));

            // Add current prompt, images, and audio if present
            const currentParts: any[] = [{ text: prompt }];

            if (imageDatas && imageDatas.length > 0) {
                imageDatas.forEach(data => {
                    currentParts.push({
                        inline_data: {
                            mime_type: "image/jpeg",
                            data: data
                        }
                    });
                });
            }

            if (audioData) {
                currentParts.push({
                    inline_data: {
                        mime_type: "audio/mp3",
                        data: audioData
                    }
                });
            }

            contents.push({
                role: 'user',
                parts: currentParts
            });

            // FIX: Ensure correct model name format for the endpoint
            // Some models might have "gemini-1.5-flash-latest" etc.
            const url = `${GOOGLE_AI_URL}/${activeProvider}:generateContent?key=${geminiKey}`;

            const response = await axios.post(
                url,
                { contents },
                { signal: controller.signal }
            );
            clearTimeout(timeout);

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                return {
                    content: response.data.candidates[0].content.parts[0].text,
                    provider: activeProvider,
                    success: true
                };
            }
            throw new Error('Gemini returned an empty response');
        } catch (error: any) {
            const isTimeout = error.name === 'AbortError' || error.code === 'ECONNABORTED';
            const statusCode = error.response?.status;
            logger.error(`❌ Direct Gemini Error (${activeProvider}) [Status: ${statusCode}]:`, error.message);

            return {
                content: '',
                provider: activeProvider,
                success: false,
                error: isTimeout ? 'AI Provider Timeout (15s exceeded)' : `Gemini Error ${statusCode || ''}: ${error.message}`
            };
        }
    }

    // 2. Otherwise use OpenRouter
    if (!openRouterKey) {
        return { success: false, error: "OpenRouter API key missing" };
    }

    logger.info(`🤖 Using OpenRouter for: ${provider}`);
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const userMessageContent: any[] = [{ type: 'text', text: prompt }];

        if (imageDatas && imageDatas.length > 0) {
            imageDatas.forEach(data => {
                userMessageContent.push({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${data}` }
                });
            });
        }

        if (audioData && !prompt) {
            userMessageContent.push({ type: 'text', text: "[Attached Audio Message]" });
        }

        const response = await axios.post(
            OPENROUTER_API_URL,
            {
                model: provider,
                messages: [
                    ...history.map((m: any) => ({ role: m.role, content: m.content })),
                    { role: 'user', content: userMessageContent.length === 1 ? prompt : userMessageContent }
                ]
            },
            {
                headers: {
                    'Authorization': `Bearer ${openRouterKey}`,
                    'HTTP-Referer': 'https://mistreal-assistant.com',
                    'X-Title': 'Mistreal Assistant'
                },
                signal: controller.signal
            }
        );
        clearTimeout(timeout);
        openRouterFailures = 0; // Reset on success

        if (!response.data || !response.data.choices || response.data.choices.length === 0) {
            throw new Error('OpenRouter returned an empty response');
        }

        return {
            content: response.data.choices[0].message.content,
            provider: provider,
            success: true
        };
    } catch (error: any) {
        const isTimeout = error.name === 'AbortError' || error.code === 'ECONNABORTED';
        const errorMessage = error.response?.data?.error?.message || error.message;

        openRouterFailures++;
        lastOpenRouterFailure = Date.now();
        logger.error(`❌ OpenRouter Error (Failures: ${openRouterFailures}):`, errorMessage);

        return {
            content: '',
            provider: provider,
            success: false,
            error: isTimeout ? 'AI Provider Timeout (15s exceeded)' : `OpenRouter Error: ${errorMessage}`
        };
    }
};
