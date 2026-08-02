import axios from 'axios';
import logger from '../utils/logger';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1'; // Standard v1 endpoint
const GOOGLE_AI_BETA_URL = 'https://generativelanguage.googleapis.com/v1beta'; // Beta endpoint

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
 * Caches models to optimize performance while remaining reactive to Google updates.
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
        // Try v1 first, fallback to v1beta for discovery
        const response = await axios.get(`${GOOGLE_AI_BASE_URL}/models?key=${geminiKey}`).catch(() =>
            axios.get(`${GOOGLE_AI_BETA_URL}/models?key=${geminiKey}`)
        );

        const allModels = response.data.models || [];

        // Step 2: Filter for generateContent capability
        const filtered = allModels.filter((m: any) =>
            m.supportedGenerationMethods.includes('generateContent') &&
            !m.name.includes('vision') && // Multimodal is standard now
            !m.name.includes('tunedModels')
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
    const name = model.name.toLowerCase();
    let score = 0;

    // Preference: latest > stable > preview > experimental
    if (name.includes('latest')) score += 100;
    if (!name.includes('experimental') && !name.includes('preview')) score += 50;
    if (name.includes('1.5')) score += 20; // Prefer 1.5 stable over legacy
    if (name.includes('flash')) score += 10; // Prefer Flash for Free tier (speed/quota)

    return score;
};

/**
 * Step 4: Resolve the absolute "Best Fit" model dynamically
 */
export const resolveBestGeminiModel = async (isPro: boolean = false): Promise<string> => {
    const liveModels = await getLiveGeminiModels();

    if (liveModels.length === 0) {
        logger.warn("⚠️ Discovery empty. Using fallback pointer.");
        return "gemini-1.5-flash-latest";
    }

    // Sort models based on our stability/version ranking
    const sorted = [...liveModels].sort((a, b) => rankModelStability(b) - rankModelStability(a));

    if (isPro) {
        // Elite users get the smartest Pro model found
        const bestPro = sorted.find(m => m.name.toLowerCase().includes('pro'));
        if (bestPro) return bestPro.name.replace('models/', '');
    }

    // Free users get the best Flash model found
    const bestFlash = sorted.find(m => m.name.toLowerCase().includes('flash'));
    if (bestFlash) return bestFlash.name.replace('models/', '');

    // Ultimate fallback to first available
    return sorted[0].name.replace('models/', '');
};

export const getAvailableModels = async (isPro: boolean) => {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const geminiModels = await getLiveGeminiModels();

    // Map Google models with dynamic labels
    let models = geminiModels.map((m: any) => {
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

    // Add OpenRouter Premium models
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

export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any, imageDatas?: string[], audioData?: string) => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    let activeProvider = provider;
    const isGoogleModel = !activeProvider.includes('/');

    const persona = user?.aiPersona || 'Shadow';
    const systemInstruction = `You are Mistreal AI, currently operating under the '${persona}' persona.
    Adhere strictly to this character trait. Current Date/Time: ${new Date().toUTCString()}.`;

    if (isGoogleModel && geminiKey) {
        try {
            // PROACTIVE DISCOVERY: Resolve target model dynamically before every call
            const targetModel = await resolveBestGeminiModel(user?.isPro);

            const contents = history.map((m: any) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }));

            const currentParts: any[] = [{ text: prompt }];
            if (imageDatas) imageDatas.forEach(d => currentParts.push({ inline_data: { mime_type: "image/jpeg", data: d } }));
            if (audioData) currentParts.push({ inline_data: { mime_type: "audio/mp3", data: audioData } });
            contents.push({ role: 'user', parts: currentParts });

            // Dynamically build URL based on model naming (version beta usually for latest flash)
            const apiVersion = targetModel.includes('flash') ? 'v1beta' : 'v1';
            const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${targetModel}:generateContent?key=${geminiKey}`;

            const response = await axios.post(url, {
                contents,
                system_instruction: { parts: [{ text: systemInstruction }] }
            });

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                return {
                    content: response.data.candidates[0].content.parts[0].text,
                    provider: targetModel,
                    success: true
                };
            }
            throw new Error('Gemini empty response');
        } catch (error: any) {
            const status = error.response?.status;
            logger.error(`❌ Gemini Error [${status}]: ${error.message}`);
            return {
                content: '',
                provider: activeProvider,
                success: false,
                error: status === 429 ? "RATE_LIMIT_REACHED" : error.message
            };
        }
    }

    // OpenRouter Logic...
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
