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
 * 📡 Dynamic Model Registry
 * Fetches models directly from Google.
 */
let cachedGeminiModels: any[] = [];
let lastFetchTime = 0;
const CACHE_TTL = 3600000; // 1 hour

export const getLiveGeminiModels = async () => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    if (!geminiKey) {
        logger.warn("⚠️ GEMINI_API_KEY is missing. Model discovery skipped.");
        return [];
    }

    const now = Date.now();
    if (cachedGeminiModels.length > 0 && (now - lastFetchTime < CACHE_TTL)) {
        return cachedGeminiModels;
    }

    try {
        const response = await axios.get(`${GOOGLE_AI_BASE_URL}/models?key=${geminiKey}`);
        const allModels = response.data.models || [];

        // Log the discovery for professional auditing in Render console
        const supportedNames = allModels
            .filter((m: any) => m.supportedGenerationMethods.includes('generateContent'))
            .map((m: any) => m.name.replace('models/', ''));

        logger.info(`📡 Gemini Model Discovery: Found ${supportedNames.length} active generation models.`);

        cachedGeminiModels = allModels;
        lastFetchTime = now;
        return cachedGeminiModels;
    } catch (error: any) {
        logger.error("❌ Google Model Discovery Failed:", error.message);
        return cachedGeminiModels;
    }
};

/**
 * 🎯 The "Smart Picker" (Zero-Hardcode Logic)
 * Scans the live list and picks the absolute best model based on capabilities.
 */
export const resolveBestGeminiModel = async (requestedId: string, isPro: boolean = false) => {
    const liveModels = await getLiveGeminiModels();

    // Filter for models that support the core functions we need (Chat, Image, Summarize)
    const candidates = liveModels.filter((m: any) =>
        m.supportedGenerationMethods.includes('generateContent') &&
        !m.name.includes('vision') // Vision is deprecated in favor of multimodal Flash/Pro
    );

    const getCleanId = (name: string) => name.replace('models/', '');

    // 1. If the user specifically requested a model that EXISTS and is SUPPORTED, use it.
    const exactMatch = candidates.find(m => getCleanId(m.name) === requestedId);
    if (exactMatch) return requestedId;

    // 2. Proactive "Best Fit" Logic
    if (isPro) {
        // Pick the most advanced Pro model available (e.g. 1.5-pro, 2.0-pro)
        const bestPro = candidates
            .filter(m => m.name.toLowerCase().includes('pro'))
            .sort((a, b) => b.name.localeCompare(a.name))[0];

        if (bestPro) return getCleanId(bestPro.name);
    }

    // 3. FREE TIER / DEFAULT: Pick the most advanced Flash model
    // This handles version jumps like 1.5 -> 2.0 automatically.
    const bestFlash = candidates
        .filter(m => m.name.toLowerCase().includes('flash'))
        .sort((a, b) => b.name.localeCompare(a.name))[0];

    if (bestFlash) {
        const resolved = getCleanId(bestFlash.name);
        logger.info(`🔄 Auto-Routing: ${requestedId} -> ${resolved} (Using latest live Flash model)`);
        return resolved;
    }

    // 4. Absolute Fallback: Use gemini-1.5-flash-latest (Google's canonical pointer)
    // We only reach here if discovery returned ZERO models.
    return "gemini-1.5-flash-latest";
};

export const getAvailableModels = async (isPro: boolean) => {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const geminiModels = await getLiveGeminiModels();

    let models: { id: string, name: string, provider: string, isProOnly: boolean, price: string }[] = [];

    if (geminiModels.length > 0) {
        models = geminiModels
            .filter((m: any) => m.supportedGenerationMethods.includes('generateContent'))
            .map((m: any) => {
                const id = m.name.replace('models/', '');
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

    // Safe fallback if discovery fails
    if (models.length === 0) {
        models = [{ id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash (Auto)', provider: 'google', isProOnly: false, price: 'Free' }];
    }

    return models;
};

export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any, imageDatas?: string[], audioData?: string) => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    let activeProvider = provider;
    const isGoogleModel = !activeProvider.includes('/');

    if (!isGoogleModel && isOpenRouterBreakerTripped()) {
        logger.warn(`⚠️ OpenRouter failures detected. Forcing high-availability Flash model.`);
        activeProvider = 'gemini';
    }

    if (isGoogleModel && geminiKey) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            // 🧠 RESOLVE OPTIMAL MODEL PROACTIVELY
            const targetModel = await resolveBestGeminiModel(activeProvider, user?.isPro);

            logger.info(`🤖 Requesting Gemini Model: ${targetModel}`);

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

            // 🚀 BUILD ENDPOINT URL
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

            logger.error(`❌ Gemini Failure [Model: ${activeProvider}] [Status: ${statusCode}]:`, errorMsg);

            return {
                content: '',
                provider: activeProvider,
                success: false,
                error: isTimeout ? 'AI Provider Timeout' : `AI Error ${statusCode || ''}: ${errorMsg}`
            };
        }
    }

    // OpenRouter Logic...
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
