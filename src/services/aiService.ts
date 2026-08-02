import axios from 'axios';
import logger from '../utils/logger';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'; // Standardizing to v1beta for widest support

const FAILURE_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60000;
const REQUEST_TIMEOUT_MS = 15000;

// 📦 Professional Multipart File Handlers
export const extractImageData = (file: Express.Multer.File): string => {
    return file.buffer.toString('base64');
};

export const extractAudioData = (file: Express.Multer.File): string => {
    return file.buffer.toString('base64');
};

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
 */
let cachedGeminiModels: any[] = [];
let lastFetchTime = 0;
const CACHE_TTL = 1800000; // 30 minutes

/**
 * Step 1 & 2: Fetch and Filter live models from Google
 */
export const getLiveGeminiModels = async () => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    if (!geminiKey) return [];

    const now = Date.now();
    if (cachedGeminiModels.length > 0 && (now - lastFetchTime < CACHE_TTL)) {
        return cachedGeminiModels;
    }

    try {
        const response = await axios.get(`${GOOGLE_AI_BASE_URL}/models?key=${geminiKey}`);
        const allModels = response.data.models || [];

        // Filter for generateContent capability
        const filtered = allModels.filter((m: any) =>
            m.supportedGenerationMethods?.includes('generateContent') &&
            !(m.name || '').includes('vision') &&
            !(m.name || '').includes('tunedModels')
        );

        cachedGeminiModels = filtered;
        lastFetchTime = now;
        logger.info(`📡 Discovery: Found ${filtered.length} capable Google models.`);
        return filtered;
    } catch (error: any) {
        logger.error("❌ Google Discovery Failed:", error.message);
        return cachedGeminiModels;
    }
};

/**
 * Step 3: Sort by version and stability ranking
 */
const rankModelStability = (model: any): number => {
    const name = (model.name || '').toLowerCase();
    let score = 0;

    // Stability: Prefer stable versions over preview/experimental
    if (name.includes('latest')) score += 100;
    if (!name.includes('experimental') && !name.includes('preview')) score += 50;

    // Performance: Prefer 1.5 versions
    if (name.includes('1.5')) score += 25;

    // Cost/Quota: Prefer Flash for general free usage
    if (name.includes('flash')) score += 10;

    return score;
};

/**
 * Step 4: Resolve the absolute "Best Fit" models dynamically (Returning top 3 for failover)
 */
export const getRankedGeminiModels = async (isPro: boolean = false): Promise<string[]> => {
    const liveModels = await getLiveGeminiModels();

    if (liveModels.length === 0) {
        return ["gemini-1.5-flash-latest"];
    }

    const sorted = [...liveModels].sort((a, b) => rankModelStability(b) - rankModelStability(a));
    const cleanName = (model: any) => model.name.replace('models/', '');

    if (isPro) {
        const proModels = sorted.filter(m => m.name.toLowerCase().includes('pro')).map(cleanName);
        if (proModels.length > 0) return proModels;
    }

    return sorted.map(cleanName);
};

export const getAvailableModels = async (isPro: boolean) => {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const geminiModels = await getLiveGeminiModels();
    const sortedGeminiModels = [...geminiModels].sort((a, b) => rankModelStability(b) - rankModelStability(a));

    let models = sortedGeminiModels.map((m: any) => {
        const id = m.name.replace('models/', '');
        const isProModel = id.includes('pro');
        return {
            id,
            name: m.displayName,
            provider: 'google',
            isProOnly: isProModel,
            price: isProModel ? 'PRO' : 'Free'
        };
    });

    if (openRouterKey) {
        try {
            const response = await axios.get('https://openrouter.ai/api/v1/models');
            if (response.data?.data) {
                const premium = response.data.data
                    .filter((m: any) => m.id.includes('gpt-4') || m.id.includes('claude'))
                    .map((m: any) => ({
                        id: m.id,
                        name: m.name,
                        provider: 'openrouter',
                        isProOnly: true,
                        price: 'PRO'
                    }));
                models = [...models, ...(isPro ? premium : premium.slice(0, 3))];
            }
        } catch (e) {}
    }

    return models;
};

interface AiResponse {
    content: string;
    provider: string;
    success: boolean;
    error?: string;
}

/**
 * 🛡️ EXECUTION WITH SELF-HEALING FAILOVER
 */
export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any, imageDatas?: string[], audioData?: string): Promise<AiResponse> => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    let activeProvider = provider;
    const isGoogleModel = !activeProvider.includes('/');

    const persona = user?.aiPersona || 'Shadow';
    const systemInstruction = `You are Mistreal AI, currently operating under the '${persona}' persona.
    Adhere strictly to this character trait. Current Date/Time: ${new Date().toUTCString()}.`;

    if (isGoogleModel && geminiKey) {
        // 🚀 DISCOVERY FAILOVER: Try the top ranked models sequentially if one fails with 404
        const candidates = await getRankedGeminiModels(user?.isPro);
        const modelsToTry = candidates.slice(0, 3); // Try top 3 most stable

        let lastError = "";

        for (const targetModel of modelsToTry) {
            try {
                logger.info(`🤖 Attempting Gemini: ${targetModel}`);

                const contents = history.map((m: any) => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }));

                const currentParts: any[] = [{ text: prompt }];
                if (imageDatas) imageDatas.forEach(d => currentParts.push({ inline_data: { mime_type: "image/jpeg", data: d } }));
                if (audioData) currentParts.push({ inline_data: { mime_type: "audio/mp3", data: audioData } });
                contents.push({ role: 'user', parts: currentParts });

                const url = `${GOOGLE_AI_BASE_URL}/models/${targetModel}:generateContent?key=${geminiKey}`;

                const response = await axios.post(url, {
                    contents,
                    system_instruction: { parts: [{ text: systemInstruction }] }
                }, { timeout: REQUEST_TIMEOUT_MS });

                if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                    return {
                        content: response.data.candidates[0].content.parts[0].text,
                        provider: targetModel,
                        success: true
                    };
                }
                throw new Error('Empty response from model');
            } catch (error: any) {
                const status = error.response?.status;
                const errorMsg = error.response?.data?.error?.message || error.message;
                lastError = errorMsg;

                logger.warn(`⚠️ Model Fail [${targetModel}] [Status: ${status}]: ${errorMsg}`);

                // If it's a 429, don't failover, just report it (it's a key limit, not a model limit)
                if (status === 429) {
                    return { content: '', provider: targetModel, success: false, error: "RATE_LIMIT_REACHED" };
                }

                // If it's a 404 or 503, try the next model in the list
                continue;
            }
        }

        // 🚨 ULTIMATE FAILOVER: If Google fails entirely, try OpenRouter free model
        if (openRouterKey) {
            logger.error(`🚨 Google failed entirely (${lastError}). Pivoting to OpenRouter failover...`);
            return await getAiResponse(prompt, 'google/gemini-flash-1.5-exp', history, user, imageDatas, audioData);
        }

        return { content: '', provider: 'discovery', success: false, error: `Critical Failure: All AI candidates failed. Last Error: ${lastError}` };
    }

    if (!openRouterKey) return { success: false, error: "AI Key missing." };

    try {
        const response = await axios.post(OPENROUTER_API_URL, {
            model: activeProvider,
            messages: [
                { role: 'system', content: systemInstruction },
                ...history.map((m: any) => ({ role: m.role, content: m.content })),
                { role: 'user', content: prompt }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${openRouterKey}`,
                'HTTP-Referer': 'https://mistreal-assistant.com',
                'X-Title': 'Mistreal Assistant'
            }
        });

        if (response.data?.choices?.[0]?.message?.content) {
            return {
                content: response.data.choices[0].message.content,
                provider: activeProvider,
                success: true
            };
        }
        throw new Error('OpenRouter empty response');
    } catch (error: any) {
        return {
            content: '',
            provider: activeProvider,
            success: false,
            error: error.message
        };
    }
};
