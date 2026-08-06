import axios from 'axios';
import logger from '../utils/logger';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const FAILURE_THRESHOLD = 3;
const REQUEST_TIMEOUT_MS = 15000;

export interface AiResponse {
    content: string;
    provider: string;
    success: boolean;
    error?: string;
}

// 📦 Professional Multipart File Handlers
export const extractImageData = (file: Express.Multer.File): string => {
    return file.buffer.toString('base64');
};

export const extractAudioData = (file: Express.Multer.File): string => {
    return file.buffer.toString('base64');
};

/**
 * 📡 Dynamic Model Registry with Capability & Quota Mapping
 */
let cachedGeminiModels: any[] = [];
let lastFetchTime = 0;
const CACHE_TTL = 1800000; // 30 minutes

export const getLiveGeminiModels = async () => {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
        logger.error("❌ GEMINI_API_KEY is missing in environment.");
        return [];
    }

    const now = Date.now();
    if (cachedGeminiModels.length > 0 && (now - lastFetchTime < CACHE_TTL)) {
        return cachedGeminiModels;
    }

    try {
        const response = await axios.get(`${GOOGLE_AI_BASE_URL}/models?key=${geminiKey}`);
        const allModels = response.data.models || [];

        // Step 2: Capability-Aware Filtering
        const filtered = allModels.filter((m: any) =>
            m.supportedGenerationMethods?.includes('generateContent') &&
            !(m.name || '').includes('tunedModels')
        );

        cachedGeminiModels = filtered;
        lastFetchTime = now;
        logger.info(`📡 AI Discovery: Found ${filtered.length} active models.`);
        return filtered;
    } catch (error: any) {
        logger.error("❌ Google Discovery Failed:", error.message);
        return cachedGeminiModels;
    }
};

/**
 * ⚖️ Stability & Performance Ranking
 */
const rankModelStability = (model: any): number => {
    const name = (model.name || '').toLowerCase();
    let score = 0;

    // Stability Matrix
    if (name.includes('latest')) score += 100;
    if (!name.includes('experimental') && !name.includes('preview')) score += 50;

    // Performance Matrix
    if (name.includes('1.5')) score += 30;
    if (name.includes('pro')) score += 20;

    // Efficiency/Quota Matrix (Good for Free Tier)
    if (name.includes('flash')) score += 10;

    return score;
};

/**
 * 🎯 The "Best Fit" Resolver
 */
export const getRankedGeminiModels = async (isPro: boolean = false): Promise<string[]> => {
    const liveModels = await getLiveGeminiModels();

    if (liveModels.length === 0) {
        return ["gemini-1.5-flash-latest"];
    }

    const sorted = [...liveModels].sort((a, b) => rankModelStability(b) - rankModelStability(a));
    const cleanName = (model: any) => model.name.replace('models/', '');

    if (isPro) {
        // High-Intelligence models for Pro
        const proModels = sorted.filter(m => m.name.toLowerCase().includes('pro')).map(cleanName);
        if (proModels.length > 0) return proModels;
    }

    // High-Quota/Speed models for Free
    const flashModels = sorted.filter(m => m.name.toLowerCase().includes('flash')).map(cleanName);
    if (flashModels.length > 0) return flashModels;

    return sorted.map(cleanName);
};

export const getAvailableModels = async (isPro: boolean) => {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const geminiModels = await getLiveGeminiModels();
    const sortedGeminiModels = [...geminiModels].sort((a, b) => rankModelStability(b) - rankModelStability(a));

    let models = sortedGeminiModels.map((m: any) => {
        const id = m.name.replace('models/', '');
        const isProModel = id.includes('pro') || (m.inputTokenLimit > 128000);
        return {
            id,
            name: m.displayName,
            provider: 'google',
            isProOnly: isProModel,
            price: isProModel ? 'PRO' : 'Free',
            quota: m.inputTokenLimit > 1000000 ? "Massive" : "Standard",
            features: m.supportedGenerationMethods?.length || 0
        };
    });

    if (openRouterKey) {
        try {
            const response = await axios.get('https://openrouter.ai/api/v1/models');
            if (response.data?.data) {
                const premium = response.data.data
                    .filter((m: any) => m.id.includes('gpt-4') || m.id.includes('claude') || m.id.includes('llama-3.1-405b'))
                    .map((m: any) => ({
                        id: m.id,
                        name: m.name,
                        provider: 'openrouter',
                        isProOnly: true,
                        price: 'PRO',
                        quota: "Premium",
                        features: 3
                    }));
                models = [...models, ...(isPro ? premium : premium.slice(0, 3))];
            }
        } catch (e) {}
    }

    return models;
};

/**
 * 🛡️ UNIVERSAL AI EXECUTION (With Smart Failover)
 */
export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any, imageDatas?: string[], audioData?: string): Promise<AiResponse> => {
    const geminiKey = process.env.GEMINI_API_KEY;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    let activeProvider = provider;
    const isGoogleModel = !activeProvider.includes('/') && activeProvider !== 'openrouter';

    const persona = user?.aiPersona || 'Shadow';
    const systemInstruction = `You are Mistreal AI, currently operating under the '${persona}' persona.
    Adhere strictly to this character trait. Current Date/Time: ${new Date().toUTCString()}.`;

    if (isGoogleModel && geminiKey) {
        // 🚀 DYNAMIC RESOLUTION: Use the model if specified, otherwise find best fit
        let targetModel = activeProvider === 'dynamic' ? "" : activeProvider;

        const rankedCandidates = await getRankedGeminiModels(user?.isPro);

        if (!targetModel || targetModel === 'dynamic') {
            targetModel = rankedCandidates[0] || "gemini-1.5-flash";
        }

        const modelsToTry: string[] = [targetModel];
        rankedCandidates.slice(0, 2).forEach(m => {
            if (!modelsToTry.includes(m)) modelsToTry.push(m);
        });

        let lastError = "";

        for (const targetModel of modelsToTry) {
            try {
                logger.info(`🤖 Intelligence Routing: Attempting ${targetModel}`);

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
                throw new Error('Null response from candidate.');
            } catch (error: any) {
                const status = error.response?.status;
                const errorMsg = error.response?.data?.error?.message || error.message;
                lastError = errorMsg;

                logger.warn(`⚠️ Routing Warning [${targetModel}] [Status: ${status}]: ${errorMsg}`);

                // If it's a 429, the whole API Key is limited. Don't waste time on failover.
                if (status === 429) {
                    return { content: '', provider: targetModel, success: false, error: "RATE_LIMIT_REACHED" };
                }

                // If it's a 404, 503, or 500, try the next model in the sequence.
                continue;
            }
        }

        // 🚨 ULTIMATE EMERGENCY PIVOT: If all Google candidates fail, try OpenRouter as a bridge.
        if (openRouterKey) {
            logger.error(`🚨 Global Google failure. Pivoting to OpenRouter bridge...`);
            return await getAiResponse(prompt, 'google/gemini-flash-1.5', history, user, imageDatas, audioData);
        }

        return { content: '', provider: 'emergency', success: false, error: `Critical Failure: All AI systems failed. Last error: ${lastError}` };
    }

    // --- OpenRouter Standard Execution ---
    if (!openRouterKey) return { content: '', provider: activeProvider, success: false, error: "AI Key missing." };

    try {
        const response = await axios.post(OPENROUTER_API_URL, {
            model: activeProvider === 'dynamic' ? 'google/gemini-flash-1.5' : activeProvider,
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
            },
            timeout: REQUEST_TIMEOUT_MS
        });

        if (response.data?.choices?.[0]?.message?.content) {
            return {
                content: response.data.choices[0].message.content,
                provider: activeProvider,
                success: true
            };
        }
        throw new Error('OpenRouter returned an empty choices array.');
    } catch (error: any) {
        return {
            content: '',
            provider: activeProvider,
            success: false,
            error: error.response?.data?.error?.message || error.message
        };
    }
};
