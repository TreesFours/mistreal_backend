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
        logger.info(`📡 Gemini Model Discovery: Found ${cachedGeminiModels.length} models.`);
        return cachedGeminiModels;
    } catch (error: any) {
        logger.error("❌ Google Discovery Failed:", error.message);
        return cachedGeminiModels;
    }
};

/**
 * 🎯 The "Smart Picker"
 */
export const resolveBestGeminiModel = async (requestedId: string, isPro: boolean = false) => {
    const liveModels = await getLiveGeminiModels();
    const candidates = liveModels.filter((m: any) =>
        m.supportedGenerationMethods.includes('generateContent') &&
        !m.name.includes('vision') && !m.name.includes('experimental')
    );

    const getCleanId = (name: string) => name.replace('models/', '');

    if (isPro) {
        const bestPro = candidates.filter(m => m.name.toLowerCase().includes('pro')).sort((a, b) => b.name.localeCompare(a.name))[0];
        if (bestPro) return getCleanId(bestPro.name);
    }

    const bestFlash = candidates.filter(m => m.name.toLowerCase().includes('flash')).sort((a, b) => b.name.localeCompare(a.name))[0];
    if (bestFlash) return getCleanId(bestFlash.name);

    return "gemini-1.5-flash-latest";
};

export const getAvailableModels = async (isPro: boolean) => {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const geminiModels = await getLiveGeminiModels();
    let models: any[] = [];

    if (geminiModels.length > 0) {
        models = geminiModels.filter((m: any) => m.supportedGenerationMethods.includes('generateContent'))
            .map((m: any) => ({
                id: m.name.replace('models/', ''),
                name: m.displayName,
                provider: 'google',
                isProOnly: m.name.includes('pro'),
                price: m.name.includes('pro') ? 'PRO' : 'Free'
            }));
    }

    if (openRouterKey) {
        try {
            const response = await axios.get('https://openrouter.ai/api/v1/models');
            if (response.data?.data) {
                const premium = response.data.data.filter((m: any) => m.id.includes('gpt-4') || m.id.includes('claude'))
                    .map((m: any) => ({ id: m.id, name: m.name, provider: 'openrouter', isProOnly: true, price: 'PRO' }));
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

    // 🎭 Build System Instruction based on User Persona
    const persona = user?.aiPersona || 'Shadow';
    const systemInstruction = `You are Mistreal AI, currently operating under the '${persona}' persona.
    Adhere strictly to this character trait. If the user provided a Custom persona description, follow it.
    Current Date/Time: ${new Date().toUTCString()}.`;

    if (isGoogleModel && geminiKey) {
        try {
            const targetModel = await resolveBestGeminiModel(activeProvider, user?.isPro);

            // Map history
            const contents = history.map((m: any) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }));

            // User message with multimodal support
            const currentParts: any[] = [{ text: prompt }];
            if (imageDatas) imageDatas.forEach(d => currentParts.push({ inline_data: { mime_type: "image/jpeg", data: d } }));
            if (audioData) currentParts.push({ inline_data: { mime_type: "audio/mp3", data: audioData } });
            contents.push({ role: 'user', parts: currentParts });

            // 🚀 Call Gemini with System Instruction
            const url = `${GOOGLE_AI_BASE_URL}/models/${targetModel}:generateContent?key=${geminiKey}`;
            const response = await axios.post(url, {
                contents,
                system_instruction: { parts: [{ text: systemInstruction }] } // ✅ EXPLICIT PERSONA
            });

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                return { content: response.data.candidates[0].content.parts[0].text, provider: targetModel, success: true };
            }
            throw new Error('Gemini empty response');
        } catch (error: any) {
            logger.error(`❌ Gemini Error: ${error.message}`);
            return { content: '', provider: activeProvider, success: false, error: `AI Error: ${error.message}` };
        }
    }

    if (!openRouterKey) return { success: false, error: "AI Key missing." };

    try {
        const response = await axios.post(OPENROUTER_API_URL, {
            model: activeProvider,
            messages: [
                { role: 'system', content: systemInstruction }, // ✅ EXPLICIT PERSONA
                ...history.map((m: any) => ({ role: m.role, content: m.content })),
                { role: 'user', content: prompt }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${openRouterKey}`, 'HTTP-Referer': 'https://mistreal-assistant.com', 'X-Title': 'Mistreal Assistant' }
        });

        if (response.data?.choices?.[0]?.message?.content) {
            return { content: response.data.choices[0].message.content, provider: activeProvider, success: true };
        }
        throw new Error('OpenRouter empty response');
    } catch (error: any) {
        return { content: '', provider: activeProvider, success: false, error: `OpenRouter Error: ${error.message}` };
    }
};
