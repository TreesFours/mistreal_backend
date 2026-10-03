import axios from 'axios';
import logger from '../utils/logger';
import { GeminiProvider } from './ai/geminiProvider';
import { OpenRouterProvider } from './ai/openRouterProvider';
import { OpenAiCompatibleProvider } from './ai/openAiCompatibleProvider';
import { AnthropicProvider } from './ai/anthropicProvider';
import { decrypt } from '../utils/secretCrypto';
import { ProviderChatResponse } from './ai/types';
import { VideoEditProvider } from './ai/videoEditProvider';
import { storeMediaBase64, buildMediaUrl } from '../utils/mediaStore';

const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface AiResponse {
    content: string;
    provider: string;
    success: boolean;
    error?: string;
    generatedImageBase64?: string;
    generatedImageMimeType?: string;
    generatedVideoUrl?: string;
}

export const IMAGE_GEN_MODEL_ID = 'imagen-3.0-generate-002';
export const VIDEO_GEN_MODEL_ID = 'veo-2.0-generate-001';
export const IMAGE_EDIT_MODEL_ID = 'gemini-2.5-flash-image';
export const VIDEO_EDIT_PROVIDER_ID = 'byok-video-edit';

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

export const extractVideoData = (file: Express.Multer.File): { base64: string, mimeType: string } => {
    const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp'];
    if (!allowed.includes(file.mimetype)) throw new Error('Invalid intel format: Video only');
    return { base64: file.buffer.toString('base64'), mimeType: file.mimetype };
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

                // Always include premium models in the catalog — the client renders
                // isProOnly entries as locked (upsell visibility) rather than hiding
                // them. Gating them out here meant free users never even received
                // the premium catalog to show as locked.
                models = [...models, ...freeOpenRouter, ...premium];
            }
        } catch (e) {}
    }

    // 🎨 Generation models (Imagen/Veo) — kept Pro-only for now since generation
    // is materially more expensive per-request than text; revisit once there's
    // real usage data to size a free-tier quota against.
    if (process.env.GEMINI_API_KEY) {
        models = [
            ...models,
            {
                id: IMAGE_GEN_MODEL_ID,
                name: 'Imagen 3 (Image Generation)',
                provider: 'google',
                isProOnly: true,
                price: 'PRO',
                quota: 'Premium Unlocked',
                health: 100,
                features: 1,
                capabilities: { text: false, imageGen: true, videoGen: false, voice: false }
            },
            {
                id: VIDEO_GEN_MODEL_ID,
                name: 'Veo 2 (Video Generation)',
                provider: 'google',
                isProOnly: true,
                price: 'PRO',
                quota: 'Premium Unlocked',
                health: 100,
                features: 1,
                capabilities: { text: false, imageGen: false, videoGen: true, voice: false }
            },
            {
                // Free by deliberate choice: background/subject editing should have
                // a free path even though generation (Imagen/Veo) is Pro-only.
                id: IMAGE_EDIT_MODEL_ID,
                name: 'Gemini Image Edit (Background/Subject)',
                provider: 'google',
                isProOnly: false,
                price: 'Free',
                quota: `${Math.floor(GEMINI_FREE_DAILY_LIMIT / freeUserCount)} req/day`,
                health: 100,
                features: 1,
                capabilities: { text: false, imageGen: true, videoGen: false, voice: false }
            }
        ];
    }

    // Return the full catalog regardless of tier — isProOnly is metadata for the
    // client to lock/badge against, not a server-side visibility filter. Stripping
    // pro-only entries here (as this used to do) hid Gemini Pro AND every
    // OpenRouter premium model from free users entirely, instead of showing them
    // locked, which is what the drawer's Free/Premium sub-tabs actually expect.
    return models;
};

/**
 * 🖼️ Imagen 3 (synchronous, single REST call).
 */
const generateImage = async (prompt: string, apiKey: string): Promise<AiResponse> => {
    try {
        const response = await axios.post(
            `${GOOGLE_AI_BASE_URL}/models/${IMAGE_GEN_MODEL_ID}:predict?key=${apiKey}`,
            { instances: [{ prompt }], parameters: { sampleCount: 1 } }
        );
        const prediction = response.data?.predictions?.[0];
        if (!prediction?.bytesBase64Encoded) {
            return { content: '', provider: IMAGE_GEN_MODEL_ID, success: false, error: 'Imagen returned no image data.' };
        }
        return {
            content: '',
            provider: IMAGE_GEN_MODEL_ID,
            success: true,
            generatedImageBase64: prediction.bytesBase64Encoded,
            generatedImageMimeType: prediction.mimeType || 'image/png'
        };
    } catch (error: any) {
        logger.error('❌ Imagen generation failed:', error.response?.data || error.message);
        return {
            content: '', provider: IMAGE_GEN_MODEL_ID, success: false,
            error: error.response?.data?.error?.message || error.message
        };
    }
};

/**
 * 🖌️ Image EDITING (not generation from scratch) — input image + instruction
 * ("change the background to a beach", "turn the person into a fox") via
 * Gemini's multimodal generateContent with image output. This is a genuinely
 * different capability from Imagen's text-to-image :predict call above, and
 * from Veo's video generation — it takes an existing image and transforms it.
 *
 * UNVERIFIED: Gemini's image-output ("nano banana") models and their exact
 * current model id are a newer, faster-moving surface than text chat —
 * confirm IMAGE_EDIT_MODEL_ID is still correct against a live account before
 * relying on this; Google renames/versions these relatively often.
 */
const editImage = async (prompt: string, imageBase64: string, mimeType: string, apiKey: string): Promise<AiResponse> => {
    try {
        const response = await axios.post(
            `${GOOGLE_AI_BASE_URL}/models/${IMAGE_EDIT_MODEL_ID}:generateContent?key=${apiKey}`,
            {
                contents: [{
                    parts: [
                        { text: prompt },
                        { inline_data: { mime_type: mimeType, data: imageBase64 } }
                    ]
                }],
                generationConfig: { responseModalities: ['IMAGE'] }
            }
        );
        const parts = response.data?.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find((p: any) => p.inlineData || p.inline_data);
        const inline = imagePart?.inlineData || imagePart?.inline_data;
        if (!inline?.data) {
            return { content: '', provider: IMAGE_EDIT_MODEL_ID, success: false, error: 'Model returned no edited image.' };
        }
        return {
            content: '',
            provider: IMAGE_EDIT_MODEL_ID,
            success: true,
            generatedImageBase64: inline.data,
            generatedImageMimeType: inline.mimeType || inline.mime_type || 'image/png'
        };
    } catch (error: any) {
        logger.error('❌ Image edit failed:', error.response?.data || error.message);
        return {
            content: '', provider: IMAGE_EDIT_MODEL_ID, success: false,
            error: error.response?.data?.error?.message || error.message
        };
    }
};

/**
 * 🎬 Veo (async long-running operation: kick off, then poll until done).
 *
 * UNVERIFIED: Google's Veo-via-Gemini-API is a newer, less-documented surface
 * than Imagen/chat. The `:predictLongRunning` request shape and the
 * `response.generateVideoResponse.generatedSamples[].video.uri` result path
 * below are our best understanding but have NOT been exercised against a real
 * API key yet — confirm/adjust field names against a live account before
 * relying on this in production.
 */
const generateVideo = async (prompt: string, apiKey: string): Promise<AiResponse> => {
    try {
        const startResponse = await axios.post(
            `${GOOGLE_AI_BASE_URL}/models/${VIDEO_GEN_MODEL_ID}:predictLongRunning?key=${apiKey}`,
            { instances: [{ prompt }], parameters: { sampleCount: 1 } }
        );
        const operationName = startResponse.data?.name;
        if (!operationName) {
            return { content: '', provider: VIDEO_GEN_MODEL_ID, success: false, error: 'Veo did not return an operation to poll.' };
        }

        const maxAttempts = 30; // ~5 minutes at 10s intervals
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10000));
            const pollResponse = await axios.get(`https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${apiKey}`);
            if (pollResponse.data?.done) {
                const videoUri = pollResponse.data?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
                if (videoUri) {
                    return { content: '', provider: VIDEO_GEN_MODEL_ID, success: true, generatedVideoUrl: `${videoUri}${videoUri.includes('?') ? '&' : '?'}key=${apiKey}` };
                }
                return { content: '', provider: VIDEO_GEN_MODEL_ID, success: false, error: pollResponse.data?.error?.message || 'Veo finished with no video URI.' };
            }
        }
        return { content: '', provider: VIDEO_GEN_MODEL_ID, success: false, error: 'Veo generation timed out.' };
    } catch (error: any) {
        logger.error('❌ Veo generation failed:', error.response?.data || error.message);
        return {
            content: '', provider: VIDEO_GEN_MODEL_ID, success: false,
            error: error.response?.data?.error?.message || error.message
        };
    }
};

/**
 * 🛡️ UNIVERSAL AI EXECUTION (With Smart Failover)
 */
export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any, imageDatas?: string[], audioData?: string, videoData?: { base64: string, mimeType: string }): Promise<AiResponse> => {
    const geminiKeyForGeneration = process.env.GEMINI_API_KEY;
    if (provider === VIDEO_EDIT_PROVIDER_ID) {
        if (!user?.byokVideoEnabled || !user?.byokVideoEncryptedKey) {
            return { content: '', provider, success: false, error: 'No video editing provider configured — add one in Settings.' };
        }
        if (!videoData) {
            return { content: '', provider, success: false, error: 'Attach a video to edit.' };
        }
        const apiKey = decrypt(user.byokVideoEncryptedKey);
        const result = await VideoEditProvider.edit({
            prompt, videoBase64: videoData.base64, mimeType: videoData.mimeType, apiKey,
            baseUrl: user.byokVideoBaseUrl, modelName: user.byokVideoModelName
        });
        if (!result.success) {
            return { content: '', provider, success: false, error: result.error };
        }
        // Normalize to a URL either way — if the provider handed back base64
        // instead, host it ourselves (mediaStore.ts) so the app always gets a
        // fetchable URL regardless of which shape the BYOK provider used.
        const videoUrl = result.videoUrl || buildMediaUrl(storeMediaBase64(result.videoBase64!, 'video/mp4'));
        return { content: '', provider: `byok-video:${user.byokVideoProviderType}`, success: true, generatedVideoUrl: videoUrl };
    }
    if (provider === IMAGE_GEN_MODEL_ID) {
        if (!geminiKeyForGeneration) return { content: '', provider, success: false, error: 'Image generation is not configured.' };
        return generateImage(prompt, geminiKeyForGeneration);
    }
    if (provider === VIDEO_GEN_MODEL_ID) {
        if (!geminiKeyForGeneration) return { content: '', provider, success: false, error: 'Video generation is not configured.' };
        return generateVideo(prompt, geminiKeyForGeneration);
    }
    if (provider === IMAGE_EDIT_MODEL_ID) {
        if (!geminiKeyForGeneration) return { content: '', provider, success: false, error: 'Image editing is not configured.' };
        if (!imageDatas || imageDatas.length === 0) return { content: '', provider, success: false, error: 'Attach an image to edit.' };
        // Same mime-type convention as GeminiProvider.chat — imageDatas doesn't
        // carry its original mime type through the pipeline, only validated bytes.
        return editImage(prompt, imageDatas[0], 'image/jpeg', geminiKeyForGeneration);
    }

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
