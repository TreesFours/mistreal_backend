import axios from 'axios';
import logger from '../utils/logger';
import { GeminiProvider } from './ai/geminiProvider';
import { OpenRouterProvider } from './ai/openRouterProvider';
import { OpenAiCompatibleProvider } from './ai/openAiCompatibleProvider';
import { AnthropicProvider } from './ai/anthropicProvider';
import { decrypt } from '../utils/secretCrypto';
import { ProviderChatResponse } from './ai/types';

const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface AiResponse {
    content: string;
    provider: string;
    success: boolean;
    error?: string;
}

// 📦 Professional Multipart File Handlers
export const extractImageData = (file: Express.Multer.File): string => {
    // 🛡️ Security: Whitelist common tactical image formats
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) throw new Error('Invalid intel format: Image only');
    return file.buffer.toString('base64');
};

export const extractAudioData = (file: Express.Multer.File): string => {
    const allowed = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/x-m4a'];
    if (!allowed.includes(file.mimetype)) throw new Error('Invalid intel format: Audio only');
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

    // 🛡️ HARD-CODED STABLE FALLBACKS (If discovery fails)
    const defaults = isPro
        ? ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-1.0-pro"]
        : ["gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-1.0-pro"];

    if (liveModels.length === 0) {
        return defaults;
    }

    const sorted = [...liveModels].sort((a: any, b: any) => rankModelStability(b) - rankModelStability(a));
    const cleanName = (model: any) => model.name.replace('models/', '');

    let candidates: string[] = [];

    if (isPro) {
        candidates = sorted.filter((m: any) => m.name.toLowerCase().includes('pro')).map(cleanName);
    } else {
        candidates = sorted.filter((m: any) => m.name.toLowerCase().includes('flash')).map(cleanName);
    }

    // Merge with defaults to ensure we always have valid IDs
    const finalModels = Array.from(new Set([...candidates, ...defaults]));
    return finalModels;
};

export const getAvailableModels = async (isPro: boolean, freeUserCount: number = 1, proUserCount: number = 1) => {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const geminiModels = await getLiveGeminiModels();
    const sortedGeminiModels = [...geminiModels].sort((a: any) => rankModelStability(a)); // Simplified sort for brevity

    // 🛡️ User Distribution Math
    // We assume standard API keys have limits. These are estimates for the "Health" display.
    const GEMINI_FREE_DAILY_LIMIT = 1500;
    const OPENROUTER_FREE_DAILY_LIMIT = 500;

    let models = sortedGeminiModels.map((m: any) => {
        const id = m.name.replace('models/', '');
        const isProModel = id.includes('pro') || (m.inputTokenLimit > 128000);

        // Calculate Quota Share
        const share = isProModel
            ? "Premium Unlocked"
            : `${Math.floor(GEMINI_FREE_DAILY_LIMIT / freeUserCount)} req/day`;

        return {
            id,
            name: m.displayName,
            provider: 'google',
            isProOnly: isProModel,
            price: isProModel ? 'PRO' : 'Free',
            quota: share,
            health: Math.floor(Math.random() * 20) + 80, // Dynamic simulation for now
            features: m.supportedGenerationMethods?.length || 0,
            // Honest capability flags: imageGen/videoGen are false everywhere until
            // generation is actually wired server-side (separate backlog item).
            // Gemini's direct-call path already accepts audioData — OpenRouter's
            // path never does — so voice differs per provider below.
            capabilities: { text: true, imageGen: false, videoGen: false, voice: true }
        };
    });

    if (openRouterKey) {
        try {
            const response = await axios.get('https://openrouter.ai/api/v1/models');
            if (response.data?.data) {
                const freeOpenRouter = response.data.data
                    .filter((m: any) => {
                        const pricing = m.pricing;
                        const isFreePrice = pricing && Number(pricing.prompt) === 0 && Number(pricing.completion) === 0;
                        const isFreeId = (m.id || '').toLowerCase().includes(':free');
                        return isFreePrice || isFreeId;
                    })
                    .map((m: any) => ({
                        id: m.id,
                        name: m.name,
                        provider: 'openrouter',
                        isProOnly: false,
                        price: 'Free',
                        quota: `${Math.floor(OPENROUTER_FREE_DAILY_LIMIT / freeUserCount)} req/day`,
                        health: Math.floor(Math.random() * 30) + 70,
                        features: 3,
                        capabilities: { text: true, imageGen: false, videoGen: false, voice: false }
                    }));

                const premium = response.data.data
                    .filter((m: any) => {
                        const id = m.id.toLowerCase();
                        // Categorize everything big as Overlord
                        return id.includes('gpt-4') || id.includes('claude-3') || id.includes('llama-3.1-405b') ||
                               id.includes('grok') || id.includes('deepseek') || id.includes('meta-llama/llama-3.1-70b');
                    })
                    .map((m: any) => ({
                        id: m.id,
                        name: m.name,
                        provider: 'openrouter',
                        isProOnly: true,
                        price: 'PRO',
                        quota: "High Bandwidth",
                        health: 100,
                        features: 3,
                        capabilities: { text: true, imageGen: false, videoGen: false, voice: false }
                    }));

                models = [...models, ...freeOpenRouter, ...(isPro ? premium : [])];
            }
        } catch (e) {}
    }

    return isPro ? models : models.filter((m: any) => !m.isProOnly);
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
    const audience = user?.aiAudience || 'None';
    const isPersonal = persona.toLowerCase().includes('personal');

    let systemInstruction = `You are Mistreal AI, operating as the '${persona}' persona.`;

    if (audience && audience !== 'None') {
        systemInstruction += ` Target Audience: ${audience}. Tailor your terminology, depth, and tone specifically for this audience.`;
    }

    if (isPersonal) {
        systemInstruction += `
        STRICT BEHAVIOR:
        - Provide a natural, conversational, and direct response to the user.
        - DO NOT use any structured headers like "SUMMARY", "CURRENT STATUS", or "FUN FACT".
        - Just answer the question or engage in the chat directly.`;
    } else {
        systemInstruction += `
        STRICT BRIEFING RULES (Apply to ALL responses):
        Every response must cover four things, in this order, but written as 1-3 flowing paragraphs of natural prose:
        - A concise overview of the topic.
        - The direct, absolute most up-to-date answer to the user's specific question (e.g., current location, direct answer to a direction request, current president).
        - Relevant background/historical context, or the logic behind how the answer was derived.
        - A unique, engaging fun fact about the subject.
        DO NOT use any visible section labels, headers, or numbering (no "SUMMARY:", "CURRENT STATUS:", "HISTORICAL CONTEXT:", "FUN FACT:", "1.", "2.", etc.) — blend all four smoothly into the paragraphs so the structure is invisible to the reader.

        MAP LOGIC:
        - If the user asks about a city, location, or directions, focus exclusively on Earth geography.
        - DO NOT include planetary or celestial data for terrestrial map questions.

        TACTICAL ARCHITECTURE PROTOCOLS:
        - If the user provides a '[TACTICAL_PERIMETER: points]', analyze the specific geographical area within those coordinates.
        - Identify critical infrastructure, tactical advantages, or defensive weaknesses within that perimeter.
        - If asked to "blueprint" or "layout" a building/plan, you MUST return a valid GeoJSON FeatureCollection in this format: [AI_BLUEPRINT: {"type":"FeatureCollection","features":[...]}]
        - Use "LineString" for walls and "Point" for markers/assets in the geoJson.
        - To mark a specific point of interest on the user's map automatically, append: [AI_MARKER: lat, lon, label].
        - Use these tags SILENTLY (the user won't see them in the main text).`;
    }

    systemInstruction += `
    AI CAPABILITIES:
    - You have internal knowledge up to 2024 and Real-Time Google Search access.
    - If asked to create a PDF or file, append "[FILE_REQUEST: type=pdf, title=FILENAME]" to your response.

    Current Date/Time: ${new Date().toUTCString()}.`;

    // 🔑 BYOK: if the user has configured and enabled their own provider, route
    // entirely through it — no fallback to the app's own Gemini/OpenRouter keys
    // on failure, since that would be a different trust boundary (billing the
    // app for a request the user explicitly asked their own key to handle).
    if (user?.byokEnabled && user?.byokProviderType && user?.byokEncryptedKey) {
        try {
            const apiKey = decrypt(user.byokEncryptedKey);
            const byokHistory = history.map((m: any) => ({ role: m.role, content: m.content }));
            let result: ProviderChatResponse;

            switch (user.byokProviderType) {
                case 'openai':
                    result = await OpenAiCompatibleProvider.chat({
                        systemInstruction, history: byokHistory, prompt, apiKey,
                        modelId: user.byokModelName || undefined, imageDatas, audioData
                    });
                    break;
                case 'openai_compatible':
                    result = await OpenAiCompatibleProvider.chat({
                        systemInstruction, history: byokHistory, prompt, apiKey,
                        modelId: user.byokModelName || undefined, baseUrl: user.byokBaseUrl || undefined,
                        imageDatas, audioData
                    });
                    break;
                case 'anthropic':
                    result = await AnthropicProvider.chat({
                        systemInstruction, history: byokHistory, prompt, apiKey,
                        modelId: user.byokModelName || undefined, imageDatas, audioData
                    });
                    break;
                case 'gemini':
                    result = await GeminiProvider.chat({
                        systemInstruction, history: byokHistory, prompt, apiKey,
                        modelCandidates: [user.byokModelName || 'gemini-1.5-flash'], imageDatas, audioData
                    });
                    break;
                default:
                    return { content: '', provider: activeProvider, success: false, error: `Unknown BYOK provider type: ${user.byokProviderType}` };
            }

            return {
                content: result.content,
                provider: `byok:${user.byokProviderType}`,
                success: result.success,
                error: result.error
            };
        } catch (error: any) {
            logger.error(`❌ BYOK execution error: ${error.message}`);
            return { content: '', provider: 'byok', success: false, error: error.message };
        }
    }

    // --- App-key path (curated models) — behavior preserved exactly ---

    if (isGoogleModel && geminiKey) {
        let targetModel = activeProvider === 'dynamic' ? "" : activeProvider;
        const rankedCandidates = await getRankedGeminiModels(user?.isPro);

        if (!targetModel || targetModel === 'dynamic') {
            targetModel = rankedCandidates[0] || "gemini-1.5-flash";
        }

        const modelsToTry: string[] = [targetModel];
        rankedCandidates.slice(0, 2).forEach((m: any) => {
            if (!modelsToTry.includes(m)) modelsToTry.push(m);
        });

        const geminiHistory = history.map((m: any) => ({ role: m.role, content: m.content }));
        const result = await GeminiProvider.chat({
            systemInstruction, history: geminiHistory, prompt, apiKey: geminiKey,
            modelCandidates: modelsToTry, imageDatas, audioData
        });

        if (result.success) {
            return { content: result.content, provider: result.modelUsed, success: true };
        }

        // 🚨 ULTIMATE EMERGENCY PIVOT: If all Google candidates fail, try OpenRouter as a bridge.
        if (openRouterKey) {
            logger.error(`🚨 Global Google failure. Pivoting to OpenRouter bridge...`);
            return await getAiResponse(prompt, 'google/gemini-flash-1.5', history, user, imageDatas, audioData);
        }

        return {
            content: '',
            provider: 'emergency',
            success: false,
            error: `AI SYSTEMS OFFLINE. Last Internal Error: ${result.error}`
        };
    }

    // --- OpenRouter Standard Execution (With Failover) ---
    if (!openRouterKey) return { content: '', provider: activeProvider, success: false, error: "AI Key missing." };

    const orModels = [
        activeProvider === 'dynamic' || activeProvider.includes('gemini-flash-1.5') ? 'google/gemini-flash-1.5' : activeProvider,
        'google/gemini-flash-1.5-8b',
        'anthropic/claude-3-haiku',
        'meta-llama/llama-3-8b-instruct:free'
    ];

    const orHistory = history.map((m: any) => ({ role: m.role, content: m.content }));
    const orResult = await OpenRouterProvider.chat({
        systemInstruction, history: orHistory, prompt, apiKey: openRouterKey, modelCandidates: orModels
    });

    if (orResult.success) {
        return { content: orResult.content, provider: orResult.modelUsed, success: true };
    }

    return { content: '', provider: activeProvider, success: false, error: orResult.error };
};
