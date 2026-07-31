import axios from 'axios';
import logger from '../utils/logger';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

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

/**
 * 📡 Dynamic Model Caching
 * Ensures we aren't hitting the model list API on every chat message,
 * but still keeps it fresh enough to handle Google updates.
 */
let cachedGeminiModels: any[] = [];
let lastFetchTime = 0;
const CACHE_TTL = 3600000; // 1 hour

export const getLiveGeminiModels = async () => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    if (!geminiKey) return [];

    const now = Date.now();
    if (cachedGeminiModels.length > 0 && (now - lastFetchTime < CACHE_TTL)) {
        return cachedGeminiModels;
    }

    try {
        const response = await axios.get(`${GOOGLE_AI_BASE_URL}/models?key=${geminiKey}`);
        cachedGeminiModels = response.data.models || [];
        lastFetchTime = now;
        logger.info(`📡 Gemini Model Registry Synchronized (${cachedGeminiModels.length} models)`);
        return cachedGeminiModels;
    } catch (error: any) {
        logger.error("❌ Failed to fetch live Gemini models:", error.message);
        return cachedGeminiModels; // Return stale cache if fetch fails
    }
};

/**
 * 🧠 Best-Fit Model Resolver
 * Proactively scans the live list and picks the most capable model
 * for the user's tier.
 */
export const resolveBestGeminiModel = async (requestedId: string, isPro: boolean = false) => {
    const liveModels = await getLiveGeminiModels();

    // Filter for models that support Content Generation
    const supported = liveModels.filter((m: any) => m.supportedGenerationMethods.includes('generateContent'));

    if (supported.length === 0) {
        logger.warn(`⚠️ No supported Gemini models found in live list. Using raw ID: ${requestedId}`);
        return requestedId;
    }

    // Normalize IDs (remove 'models/' prefix for internal matching)
    const getCleanId = (name: string) => name.replace('models/', '');

    // 1. PRO TIER Logic
    if (isPro) {
        // If user specifically requested a Pro model, use it if it exists and is supported
        const exactMatch = supported.find(m => getCleanId(m.name) === requestedId);
        if (exactMatch) return requestedId;

        // Otherwise, proactively pick the best available Pro model
        const latestPro = supported.find(m => m.name.includes('1.5-pro')) ||
                        supported.find(m => m.name.includes('pro'));

        if (latestPro) return getCleanId(latestPro.name);
    }

    // 2. FREE TIER / DEFAULT Logic
    // Proactively pick the absolute latest Flash model
    const latestFlash = supported.find(m => m.name.includes('1.5-flash-latest')) ||
                        supported.find(m => m.name.includes('1.5-flash')) ||
                        supported.find(m => m.name.includes('flash'));

    if (latestFlash) {
        const resolved = getCleanId(latestFlash.name);
        if (resolved !== requestedId) {
            logger.info(`🔄 Dynamic Route: Mapping ${requestedId} -> ${resolved} (Proactive Sync)`);
        }
        return resolved;
    }

    // 3. Last Resort: Pick the first supported model in the list
    return getCleanId(supported[0].name);
};

export const getAvailableModels = async (isPro: boolean) => {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const geminiModels = await getLiveGeminiModels();

    let models: { id: string, name: string, provider: string, isProOnly: boolean, price: string }[] = [];

    // 1. DYNAMIC GOOGLE MODELS
    if (geminiModels.length > 0) {
        models = geminiModels
            .filter((m: any) => m.supportedGenerationMethods.includes('generateContent'))
            .map((m: any) => {
                const fullName = m.name;
                const id = fullName.replace('models/', '');
                const isProModel = id.includes('pro') || id.includes('ultra');
                return {
                    id: id,
                    name: m.displayName,
                    provider: 'google',
                    isProOnly: isProModel,
                    price: isProModel ? 'PRO' : 'Free'
                };
            });
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

                if (isPro) {
                    models = [...models, ...premiumModels];
                } else {
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
            { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'google', isProOnly: false, price: 'Free' }
        ];
    }

    return models;
};

export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any, imageDatas?: string[], audioData?: string) => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    let activeProvider = provider;
    const isGoogleModel = !activeProvider.includes('/');

    if (!isGoogleModel && isOpenRouterBreakerTripped()) {
        logger.warn(`⚠️ OpenRouter breaker TRIPPED. Falling back to Gemini.`);
        activeProvider = 'gemini'; // This will be resolved to the best Flash model below
    }

    if (isGoogleModel && geminiKey) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            // 🧠 PROACTIVE DYNAMIC RESOLUTION:
            // Instead of trying a model that might be dead, we resolve the "Best Fit"
            // from the live list before making the call.
            const targetModel = await resolveBestGeminiModel(activeProvider, user?.isPro);

            logger.info(`🤖 Calling Google Gemini API: ${targetModel}`);

            const contents = history.map((m: any) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }));

            const currentParts: any[] = [{ text: prompt }];
            if (imageDatas && imageDatas.length > 0) {
                imageDatas.forEach(data => {
                    currentParts.push({ inline_data: { mime_type: "image/jpeg", data: data } });
                });
            }
            if (audioData) {
                currentParts.push({ inline_data: { mime_type: "audio/mp3", data: audioData } });
            }

            contents.push({ role: 'user', parts: currentParts });

            // 🚀 SECURE URL CONSTRUCTION
            const url = `${GOOGLE_AI_BASE_URL}/models/${targetModel}:generateContent?key=${geminiKey}`;

            const response = await axios.post(url, { contents }, { signal: controller.signal });
            clearTimeout(timeout);

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                return {
                    content: response.data.candidates[0].content.parts[0].text,
                    provider: targetModel,
                    success: true
                };
            }
            throw new Error('Gemini returned an empty response');
        } catch (error: any) {
            const isTimeout = error.name === 'AbortError' || error.code === 'ECONNABORTED';
            const statusCode = error.response?.status;
            const errorMsg = error.response?.data?.error?.message || error.message;
            logger.error(`❌ Gemini Failure [Status: ${statusCode}]:`, errorMsg);

            return {
                content: '',
                provider: activeProvider,
                success: false,
                error: isTimeout ? 'AI Provider Timeout' : `AI Error ${statusCode || ''}: ${errorMsg}`
            };
        }
    }

    // 2. OpenRouter Logic...
    if (!openRouterKey) return { success: false, error: "AI Key missing." };

    logger.info(`🤖 Using OpenRouter for: ${activeProvider}`);
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const userMessageContent: any[] = [{ type: 'text', text: prompt }];

        if (imageDatas && imageDatas.length > 0) {
            imageDatas.forEach(data => {
                userMessageContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } });
            });
        }
        if (audioData && !prompt) userMessageContent.push({ type: 'text', text: "[Attached Audio Message]" });

        const response = await axios.post(OPENROUTER_API_URL, {
            model: activeProvider,
            messages: [
                ...history.map((m: any) => ({ role: m.role, content: m.content })),
                { role: 'user', content: userMessageContent.length === 1 ? prompt : userMessageContent }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${openRouterKey}`, 'HTTP-Referer': 'https://mistreal-assistant.com', 'X-Title': 'Mistreal Assistant' },
            signal: controller.signal
        });
        clearTimeout(timeout);
        openRouterFailures = 0;

        if (!response.data || !response.data.choices || response.data.choices.length === 0) throw new Error('Empty OpenRouter response');

        return { content: response.data.choices[0].message.content, provider: activeProvider, success: true };
    } catch (error: any) {
        const isTimeout = error.name === 'AbortError' || error.code === 'ECONNABORTED';
        const errorMessage = error.response?.data?.error?.message || error.message;
        openRouterFailures++;
        lastOpenRouterFailure = Date.now();
        return { content: '', provider: activeProvider, success: false, error: isTimeout ? 'AI Provider Timeout' : `OpenRouter Error: ${errorMessage}` };
    }
};
