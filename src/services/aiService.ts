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

export const getAvailableModels = async (isPro: boolean) => {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const geminiModels = await getLiveGeminiModels();
    const sortedGeminiModels = [...geminiModels].sort((a: any, b: any) => rankModelStability(b) - rankModelStability(a));

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
                // 🆓 OPENROUTER FREE MODELS: Automatically extract all models with 0 pricing or ':free' suffix
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
                        quota: "Free Tier",
                        features: 3
                    }));

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

                // 🛡️ TIER-BASED FILTERING: Only show premium models to Pro users
                models = [...models, ...freeOpenRouter, ...(isPro ? premium : [])];
            }
        } catch (e) {}
    }

    // Final safety filter: Ensure free users never see Pro-only models
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

    if (isGoogleModel && geminiKey) {
        // 🚀 DYNAMIC RESOLUTION: Use the model if specified, otherwise find best fit
        let targetModel = activeProvider === 'dynamic' ? "" : activeProvider;

        const rankedCandidates = await getRankedGeminiModels(user?.isPro);

        if (!targetModel || targetModel === 'dynamic') {
            targetModel = rankedCandidates[0] || "gemini-1.5-flash";
        }

        const modelsToTry: string[] = [targetModel];
        rankedCandidates.slice(0, 2).forEach((m: any) => {
            if (!modelsToTry.includes(m)) modelsToTry.push(m);
        });

        let lastError = "";

        for (const targetModel of modelsToTry) {
            try {
                // 🛡️ CRITICAL FIX: Ensure no double-prefixing or invalid "google/" strings
                const cleanModelName = targetModel.replace('models/', '').replace('google/', '').trim();

                logger.info(`🤖 Intelligence Routing: Attempting ${cleanModelName}`);

                const contents = history.map((m: any) => ({
                    role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }));

                const currentParts: any[] = [{ text: prompt }];
                if (imageDatas) imageDatas.forEach((d: any) => currentParts.push({ inline_data: { mime_type: "image/jpeg", data: d } }));
                if (audioData) currentParts.push({ inline_data: { mime_type: "audio/mp3", data: audioData } });
                contents.push({ role: 'user', parts: currentParts });

                const url = `${GOOGLE_AI_BASE_URL}/models/${cleanModelName}:generateContent?key=${geminiKey}`;
                logger.info(`📡 AI Direct Execution: ${cleanModelName}`);

                const response = await axios.post(url, {
                    contents,
                    system_instruction: { parts: [{ text: systemInstruction }] },
                    tools: [{
                        google_search_retrieval: {
                            dynamic_retrieval_config: { mode: "MODE_DYNAMIC", dynamic_threshold: 0.3 }
                        }
                    }]
                }, {
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: () => true // Catch all statuses to log full details
                });

                if (response.status === 200 && response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                    return {
                        content: response.data.candidates[0].content.parts[0].text,
                        provider: targetModel,
                        success: true
                    };
                }

                // CRITICAL AUDIT: Detailed error capture for "No Endpoint" debugging
                const remoteError = response.data?.error?.message || response.statusText;
                lastError = `[HTTP ${response.status}] ${remoteError}`;
                logger.error(`❌ Gemini API Failure [${cleanModelName}]: ${lastError}`);

                if (response.status === 404) {
                    lastError = `ENDPOINT_NOT_FOUND: The model name '${cleanModelName}' might be incorrect for your API key region.`;
                }

                continue;
            } catch (error: any) {
                lastError = error.message;
                logger.error(`❌ Gemini Network/Axios Error: ${lastError}`);
                continue;
            }
        }

        // 🚨 ULTIMATE EMERGENCY PIVOT: If all Google candidates fail, try OpenRouter as a bridge.
        if (openRouterKey) {
            logger.error(`🚨 Global Google failure. Pivoting to OpenRouter bridge...`);
            // Corrected OpenRouter model ID for Gemini 1.5 Flash (Use most stable ID)
            // Try flash first, if it fails, the OpenRouter block below will catch and report.
            return await getAiResponse(prompt, 'google/gemini-flash-1.5', history, user, imageDatas, audioData);
        }

        return {
            content: '',
            provider: 'emergency',
            success: false,
            error: `AI SYSTEMS OFFLINE. Last Internal Error: ${lastError}`
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

    let orLastError = "";

    for (const modelId of orModels) {
        try {
            const response = await axios.post(OPENROUTER_API_URL, {
                model: modelId,
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
                timeout: REQUEST_TIMEOUT_MS,
                validateStatus: (status) => status < 500 // Fail on 5xx, but catch 404/429
            });

            if (response.status === 200 && response.data?.choices?.[0]?.message?.content) {
                return {
                    content: response.data.choices[0].message.content,
                    provider: `openrouter/${modelId}`,
                    success: true
                };
            }

            orLastError = response.data?.error?.message || `HTTP ${response.status}`;
            logger.warn(`⚠️ OpenRouter Model ${modelId} failed: ${orLastError}`);
            continue;
        } catch (error: any) {
            orLastError = error.message;
            logger.error(`❌ OpenRouter Connection Error [${modelId}]: ${orLastError}`);
            continue;
        }
    }

    return {
        content: '',
        provider: activeProvider,
        success: false,
        error: `PROVIDER_ERROR: ${orLastError} (Checked ${orModels.length} models)`
    };
};
