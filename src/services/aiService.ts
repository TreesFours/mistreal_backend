import axios from 'axios';
import PDFDocument from 'pdfkit';
import logger from '../utils/logger';
import { GeminiProvider } from './ai/geminiProvider';
import { OpenRouterProvider } from './ai/openRouterProvider';
import { OpenAiCompatibleProvider } from './ai/openAiCompatibleProvider';
import { AnthropicProvider } from './ai/anthropicProvider';
import { decrypt } from '../utils/secretCrypto';
import { ProviderChatResponse } from './ai/types';
import { VideoEditProvider } from './ai/videoEditProvider';
import { ImageGenProvider } from './ai/imageGenProvider';
import { AiProviderConfig } from '../models/AiProviderConfig';
import { storeMediaBase64, buildMediaUrl } from '../utils/mediaStore';
import { hasAddon } from './addonService';
import { checkDomainRateLimit } from '../utils/domainRateLimiter';

const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface AiResponse {
    content: string;
    provider: string;
    success: boolean;
    error?: string;
    generatedImageBase64?: string;
    generatedImageMimeType?: string;
    generatedImageUrl?: string;
    generatedVideoUrl?: string;
    generatedFileBase64?: string;
    generatedFileMimeType?: string;
    generatedFileName?: string;
    // Only ever set when Gemini's google_search_retrieval tool grounded the
    // answer — previously computed and immediately discarded.
    groundingCitations?: { uri: string; title?: string }[];
}

export const IMAGE_GEN_MODEL_ID = 'imagen-3.0-generate-002';
// Veo 3.1 (not 2.0) is what actually supports first/last-frame keyframe
// conditioning on this same Gemini API surface — confirmed against
// ai.google.dev: instances[0].image / instances[0].lastFrame, each
// {inlineData:{mimeType,data}}. Veo 3.1 Lite does NOT support this, so this
// must stay on full 3.1 or 3.1 Fast.
export const VIDEO_GEN_MODEL_ID = 'veo-3.1-generate-preview';
export const IMAGE_EDIT_MODEL_ID = 'gemini-2.5-flash-image';
export const VIDEO_EDIT_PROVIDER_ID = 'byok-video-edit';
// Clarify-then-render image assistants — always use the app's own Gemini
// key for their vision step (see getAiResponse's DOMAIN_CONFIGS branch
// below), since that's the only chat provider in this codebase that
// actually sends attached image bytes to the model at all; BYOK
// OpenAI/Anthropic silently drop them (see
// openAiCompatibleProvider.ts/anthropicProvider.ts).
export const ARCH_IMAGE_PROVIDER_ID = 'mistreal-architect';

const ARCH_IMAGE_SYSTEM_INSTRUCTION = `You are Mistreal AI's architectural render assistant.
The user wants a rendered image of a building, room, or floor plan, possibly starting from a rough sketch, photo, or PDF they attached.

RULES:
- If you don't have enough detail to render something meaningful (room count, approximate dimensions, 2D floor-plan vs. 3D-style view, overall style), ask ONE concise clarifying question. Do not generate an image yet.
- On every reply, restate your current understanding of the request as a single tag, exactly in this form (valid JSON, one line): [DOMAIN_UNDERSTANDING: {"rooms": <number or null>, "dimensions": "<string or null>", "scale": "2D floor plan" or "3D-style view", "style": "<string or null>", "confirmed": false}]
- Fill in your best guess for any field the user hasn't stated yet rather than leaving everything null — the user can see and correct your guess.
- Never set "confirmed": true yourself — that only happens when the user explicitly confirms via the app's own UI, which will tell you so directly in a follow-up message.
- If a follow-up message tells you the user confirmed the current understanding and wants the image generated, acknowledge briefly and mention plainly that what follows is a styled concept render informed by the stated measurements, NOT a precision CAD or architectural blueprint drawing — real-world construction should never rely on it for exact measurements.
- Keep every reply to 1-3 short sentences outside of the tag.`;

/**
 * Describe → clarify → generate domains. Architecture is the only real
 * entry today — this map exists so a future domain (e.g. a medical-image
 * flow) is just one more object literal here, with zero changes needed
 * anywhere else: getAiResponse's branch, getAvailableModels' catalog
 * entries, and the client's [DOMAIN_UNDERSTANDING] tag/card are all already
 * generic over whatever's in this map.
 */
interface DomainConfig {
    id: string;
    displayName: string;
    requiresAddon?: string;
    systemInstruction: string;
    buildRenderPrompt: (understanding: any, rawPrompt: string) => string;
}

const DOMAIN_CONFIGS: Record<string, DomainConfig> = {
    [ARCH_IMAGE_PROVIDER_ID]: {
        id: ARCH_IMAGE_PROVIDER_ID,
        displayName: 'Architectural Render',
        requiresAddon: 'ai_pro',
        systemInstruction: ARCH_IMAGE_SYSTEM_INSTRUCTION,
        buildRenderPrompt: (understanding, prompt) => [
            'Architectural concept render, not a precision CAD drawing.',
            understanding.scale ? `View: ${understanding.scale}.` : '',
            understanding.rooms ? `${understanding.rooms} rooms.` : '',
            understanding.dimensions ? `Approximate dimensions: ${understanding.dimensions}.` : '',
            understanding.style ? `Style: ${understanding.style}.` : '',
            prompt
        ].filter(Boolean).join(' ')
    }
};

export const DOMAIN_PROVIDER_IDS = new Set(Object.keys(DOMAIN_CONFIGS));

// 📦 Professional Multipart File Handlers
export const extractImageData = (file: Express.Multer.File): string => {
    // 🛡️ Security: Whitelist common tactical image formats
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) throw new Error('Invalid intel format: Image only');
    return file.buffer.toString('base64');
};

/**
 * Same whitelist as extractImageData plus PDF — only ever used for
 * attachments going into a DOMAIN_CONFIGS flow (see index.ts's isDomainFlow
 * check). Kept separate from extractImageData, which stays image-only for
 * every other caller (scene mode, ordinary chat vision, IMAGE_EDIT_MODEL_ID)
 * — those all still assume 'image/jpeg' downstream, so a PDF must never
 * reach them.
 */
export const extractAttachmentData = (file: Express.Multer.File): { base64: string; mimeType: string } => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) throw new Error('Invalid intel format: Image or PDF only');
    return { base64: file.buffer.toString('base64'), mimeType: file.mimetype };
};

export const extractAudioData = (file: Express.Multer.File): string => {
    // audio/mp4 is what Android's MimeTypeMap actually reports for a ".m4a" file
    // (MPEG-4/AAC container) — audio/x-m4a is kept for other clients that use it.
    const allowed = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/x-m4a', 'audio/mp4'];
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

    // Performance Matrix — was a hardcoded `includes('1.5')` check, so it
    // never recognized any later generation (2.0, 2.5, ...) as better than
    // an older one; Google ships a new generation faster than this file
    // gets hand-edited. Extracts whichever "major.minor" version number
    // actually appears in the name and scores it proportionally instead,
    // so this stays correct without another manual patch next release.
    const versionMatch = name.match(/(\d+)\.(\d+)/);
    if (versionMatch) {
        const major = parseInt(versionMatch[1], 10);
        const minor = parseInt(versionMatch[2], 10);
        score += Math.min(major * 10 + minor, 60);
    }
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
        ? ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro"]
        : ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

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

    // Was an unconditional merge with the hardcoded defaults above, every
    // single call — meaning long-deprecated model ids (gemini-1.5-*,
    // gemini-1.0-pro) always sat in the final candidate list even when live
    // discovery found perfectly good current models, and any caller using
    // more than the first couple of candidates (getAiResponse's domain-config
    // branch passes this whole list straight to GeminiProvider.chat) could
    // genuinely land on a dead model id. Only reached now if live discovery
    // actually found nothing in this tier at all.
    return candidates.length > 0 ? candidates : defaults;
};

// 📋 Live Free/Premium text-model catalog — sourced entirely from
// OpenRouter's own /models endpoint, tiered by OpenRouter's own real pricing
// data (not a guessed name allowlist). No model id is ever hardcoded here —
// whatever OpenRouter actually offers today is what gets listed today. The
// "Dynamic (Best Fit)" entry stays a client-side sentinel (added in
// AiProviderSelector.kt, never sent from here) that routes straight to the
// app's own Gemini key — see isGoogleModel's 'dynamic' handling in
// getAiResponse — so dropping direct-Gemini catalog entries here doesn't
// remove direct-Gemini access, just the separate always-listed duplicates.
const getLiveOpenRouterModels = async (): Promise<any[]> => {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) return [];

    try {
        const response = await axios.get('https://openrouter.ai/api/v1/models');
        const all = response.data?.data || [];
        return all
            // Sanity filter, not a curated allowlist: drop entries missing the
            // fields we actually read, and non-text models (embeddings,
            // moderation-only) that would dead-end a chat request.
            .filter((m: any) => m.id && m.pricing && m.architecture?.modality !== 'text->embedding')
            .map((m: any) => {
                const promptPrice = Number(m.pricing?.prompt ?? 0);
                const completionPrice = Number(m.pricing?.completion ?? 0);
                const isFree = (promptPrice === 0 && completionPrice === 0) || m.id.toLowerCase().endsWith(':free');
                return {
                    id: m.id,
                    name: m.name || m.id,
                    provider: 'openrouter',
                    isProOnly: !isFree,
                    price: isFree ? 'Free' : 'PRO',
                    capabilities: { text: true, imageGen: false, videoGen: false, voice: false }
                };
            });
    } catch (e: any) {
        logger.warn(`⚠️ OpenRouter model catalog fetch failed — catalog will be missing live text models: ${e.message}`);
        return [];
    }
};

export const getAvailableModels = async () => {
    let models: any[] = await getLiveOpenRouterModels();

    // Outage safety net only — reached only when OpenRouter is unreachable or
    // OPENROUTER_API_KEY isn't set, so chat never ends up with zero options.
    // Not part of the normal catalog path, so it's never what a user actually
    // sees day to day.
    if (models.length === 0) {
        models = [{
            id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (Free)', provider: 'openrouter',
            isProOnly: false, price: 'Free', capabilities: { text: true, imageGen: false, videoGen: false, voice: false }
        }];
    }

    // 🎨 Free & Pro Generation models (Pollinations, Hugging Face, Imagen, Veo)
    models = [
        ...models,
        {
            id: 'pollinations',
            name: 'Pollinations AI (FLUX.1 Free Generator)',
            provider: 'pollinations',
            isProOnly: false,
            price: 'Free',
            capabilities: { text: false, imageGen: true, videoGen: false, voice: false }
        },
        {
            id: 'huggingface',
            name: 'Hugging Face (FLUX.1-schnell Free)',
            provider: 'huggingface',
            isProOnly: false,
            price: 'Free',
            capabilities: { text: false, imageGen: true, videoGen: false, voice: false }
        },
        {
            id: IMAGE_GEN_MODEL_ID,
            name: 'Imagen 3 (Image Generation)',
            provider: 'google',
            isProOnly: true,
            price: 'PRO',
            capabilities: { text: false, imageGen: true, videoGen: false, voice: false }
        },
        {
            // Free counterpart to Veo — selecting VIDEO_GEN_MODEL_ID without
            // ai_pro now auto-routes here server-side too (see getAiResponse),
            // this entry just makes the free option directly selectable/visible
            // rather than only reachable as an invisible fallback.
            id: 'huggingface-video',
            name: 'Hugging Face (Free Text-to-Video)',
            provider: 'huggingface',
            isProOnly: false,
            price: 'Free',
            capabilities: { text: false, imageGen: false, videoGen: true, voice: false }
        },
        {
            id: VIDEO_GEN_MODEL_ID,
            name: 'Veo 2 (Video Generation)',
            provider: 'google',
            isProOnly: true,
            price: 'PRO',
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
            capabilities: { text: false, imageGen: true, videoGen: false, voice: false }
        },
        // Clarify-then-render flow(s): text (clarifying Q&A) AND imageGen
        // (the confirmed concept render) both apply to every entry here.
        // Architecture is the only real one today — a future domain is
        // just one more DOMAIN_CONFIGS object, with no new code here.
        ...Object.values(DOMAIN_CONFIGS).map(cfg => ({
            id: cfg.id,
            name: cfg.displayName,
            provider: 'google',
            isProOnly: !!cfg.requiresAddon,
            price: cfg.requiresAddon ? 'PRO' : 'Free',
            capabilities: { text: true, imageGen: true, videoGen: false, voice: false }
        }))
    ];

    // Return the full catalog regardless of tier — isProOnly is metadata for the
    // client to lock/badge against, not a server-side visibility filter. The
    // drawer's Free/Premium sub-tabs filter on isProOnly client-side.
    return models;
};

/**
 * 🖼️ Free Image Generation via Pollinations.ai (Keyless, 100% Free, FLUX.1 Engine)
 */
export const generatePollinationsImage = async (prompt: string): Promise<AiResponse> => {
    try {
        const encodedPrompt = encodeURIComponent(prompt);
        const seed = Math.floor(Math.random() * 1000000);
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&model=flux&seed=${seed}&nologo=true`;

        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 25000
        });

        const base64 = Buffer.from(response.data).toString('base64');
        return {
            content: 'Image generated via Pollinations FLUX.1 Engine',
            provider: 'pollinations',
            success: true,
            generatedImageBase64: base64,
            generatedImageMimeType: 'image/jpeg'
        };
    } catch (e: any) {
        logger.error('❌ Pollinations Image Generation Error:', e.message);
        return {
            content: '',
            provider: 'pollinations',
            success: false,
            error: `Pollinations generation failed: ${e.message}`
        };
    }
};

/**
 * 🖼️ Free Image Generation via Hugging Face Inference API (FLUX.1-schnell / SDXL)
 */
export const generateHuggingFaceImage = async (prompt: string, token?: string): Promise<AiResponse> => {
    try {
        const hfToken = token || process.env.HUGGINGFACE_API_KEY;
        const hfUrl = 'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;

        const response = await axios.post(
            hfUrl,
            { inputs: prompt },
            { headers, responseType: 'arraybuffer', timeout: 30000 }
        );

        const base64 = Buffer.from(response.data).toString('base64');
        return {
            content: 'Image generated via Hugging Face FLUX.1 Engine',
            provider: 'huggingface',
            success: true,
            generatedImageBase64: base64,
            generatedImageMimeType: 'image/jpeg'
        };
    } catch (e: any) {
        logger.warn(`⚠️ HuggingFace generation warning (${e.message}) — pivoting to Pollinations fallback...`);
        return generatePollinationsImage(prompt);
    }
};

/**
 * 🎬 Free Video Generation via Hugging Face Inference API (ModelScope
 * text-to-video) — the free-tier counterpart to Veo, same keyless pattern as
 * generateHuggingFaceImage above. Free HF inference models commonly return a
 * 503 with an `estimated_time` while they cold-start from standby; this is
 * the normal first-call experience for a low-traffic free model, not an
 * error condition, so one bounded retry after that wait is part of making
 * this actually usable rather than "works maybe 1 in 3 tries."
 */
export const generateHuggingFaceVideo = async (prompt: string, token?: string): Promise<AiResponse> => {
    const hfToken = token || process.env.HUGGINGFACE_API_KEY;
    const hfUrl = 'https://api-inference.huggingface.co/models/damo-vilab/text-to-video-ms-1.7b';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;

    const attempt = async (): Promise<AiResponse> => {
        const response = await axios.post(
            hfUrl,
            { inputs: prompt },
            { headers, responseType: 'arraybuffer', timeout: 90000 }
        );
        const videoUrl = buildMediaUrl(storeMediaBase64(Buffer.from(response.data).toString('base64'), 'video/mp4'));
        return { content: 'Video generated via Hugging Face (free engine)', provider: 'huggingface-video', success: true, generatedVideoUrl: videoUrl };
    };

    try {
        return await attempt();
    } catch (e: any) {
        // A cold-starting model answers with JSON (not video bytes), but
        // responseType:'arraybuffer' means axios hands it back as a Buffer
        // regardless — have to parse it back to text to read estimated_time.
        const raw = e.response?.data;
        let estimatedTime: number | undefined;
        if (Buffer.isBuffer(raw)) {
            try { estimatedTime = JSON.parse(raw.toString('utf-8'))?.estimated_time; } catch { /* not JSON — a real failure */ }
        }
        if (e.response?.status === 503 && estimatedTime) {
            const waitMs = Math.min(estimatedTime * 1000, 25000);
            logger.info(`⏳ Free video engine cold-starting (~${estimatedTime}s) — retrying once...`);
            await new Promise(r => setTimeout(r, waitMs));
            try {
                return await attempt();
            } catch (retryErr: any) {
                logger.error('❌ Free video generation failed after retry:', retryErr.message);
                return { content: '', provider: 'huggingface-video', success: false, error: 'Free video engine is warming up — try again in about a minute.' };
            }
        }
        logger.error('❌ Free video generation error:', e.message);
        return { content: '', provider: 'huggingface-video', success: false, error: `Free video generation failed: ${e.message}` };
    }
};

/**
 * 📄 Real PDF generation for the [FILE_REQUEST: ...] tag. This used to be
 * pure theater: the model was told to emit the tag, and the only thing that
 * happened with it was the client swapping the tag for cosmetic text
 * ("Secure File generated and encrypted") — no file was ever created,
 * anywhere. This renders the AI's own reply text into an actual PDF and
 * hands back real bytes, same contract as generateImage's base64 return so
 * the Android side can save it immediately and permanently (not through
 * mediaStore.ts's 15-minute TTL store, which is designed for a quick "hand
 * to Zernio" hop, not a file the user may want hours later).
 */
const generatePdfFile = async (title: string, bodyText: string): Promise<{ success: true; fileBase64: string } | { success: false; error: string }> => {
    try {
        const doc = new PDFDocument({ margin: 50 });
        const chunks: Buffer[] = [];
        // doc.end() does not synchronously flush the stream — the 'data'
        // chunks and the final 'end' event arrive on later ticks, so the
        // buffer has to be assembled by actually awaiting 'end', not read
        // right after calling end().
        const done = new Promise<Buffer>((resolve, reject) => {
            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
        });
        doc.fontSize(18).text(title || 'Mistreal AI Document', { underline: true });
        doc.moveDown();
        doc.fontSize(12).text(bodyText || '', { align: 'left' });
        doc.end();
        const buffer = await done;
        return { success: true, fileBase64: buffer.toString('base64') };
    } catch (error: any) {
        logger.error('❌ PDF generation failed:', error.message);
        return { success: false, error: error.message };
    }
};

const sanitizePdfTitle = (title: string): string => title.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'Mistreal Document';

// 🎨 Image style presets — a fixed set of user-facing labels (not model
// names), applied as a prompt descriptor so every image engine (Pollinations,
// HuggingFace, Imagen, BYOK) renders in the style the user actually asked
// for instead of whatever the base model defaults to. Used both by the
// explicit image-gen providers below and by attachGeneratedMedia's
// [INLINE_MEDIA: style=...] tag, so "ask any connected AI to draw something
// in style X" behaves identically everywhere.
export const IMAGE_STYLE_DESCRIPTORS: Record<string, string> = {
    realistic: 'photorealistic, highly detailed, natural lighting, DSLR photo quality',
    animation: '3D animated movie style, vibrant colors, Pixar/Disney-style rendering',
    anime: 'anime style, Japanese animation, cel-shaded, vibrant line art',
    painting: 'digital painting, fine art illustration, expressive brush strokes',
    sketch: 'pencil sketch, hand-drawn line art, monochrome shading'
};

const applyImageStyle = (prompt: string, imageStyle?: string): string => {
    const descriptor = imageStyle ? IMAGE_STYLE_DESCRIPTORS[imageStyle.toLowerCase()] : undefined;
    return descriptor ? `${prompt}. Style: ${descriptor}.` : prompt;
};

/**
 * Shared by every chat path (app-key Gemini, every BYOK provider) so "ask
 * any connected AI to draw something" or "...to make me a file" behaves
 * identically everywhere, instead of only working on the one branch that
 * happened to check for it first. Checks the model's own reply text for the
 * two tags its system prompt was told it can use, and resolves them for
 * real:
 *   [INLINE_MEDIA: prompt=...]              -> generates an image (Pollinations)
 *   [FILE_REQUEST: type=pdf, title=...]     -> generates a real PDF of the reply
 * Strips whichever tag matched from the visible text either way, so neither
 * leaks into what the user reads.
 */
const attachGeneratedMedia = async (content: string, provider: string, groundingCitations?: { uri: string; title?: string }[]): Promise<AiResponse> => {
    const inlineMediaMatch = content.match(/\[INLINE_MEDIA:\s*(?:style=([^,\s\]]+),\s*)?prompt=([^\]]+)\]/i);
    if (inlineMediaMatch) {
        const mediaPrompt = inlineMediaMatch[2].trim();
        const cleanContent = content.replace(inlineMediaMatch[0], '').trim();
        const imageRes = await generatePollinationsImage(applyImageStyle(mediaPrompt, inlineMediaMatch[1]));
        if (imageRes.success) {
            return {
                content: cleanContent, provider, success: true,
                generatedImageBase64: imageRes.generatedImageBase64,
                generatedImageMimeType: imageRes.generatedImageMimeType,
                groundingCitations
            };
        }
        return { content: cleanContent, provider, success: true, groundingCitations };
    }

    const fileRequestMatch = content.match(/\[FILE_REQUEST:\s*type=([a-z]+),\s*title=([^\]]+)\]/i);
    if (fileRequestMatch) {
        const title = sanitizePdfTitle(fileRequestMatch[2].trim());
        const cleanContent = content.replace(fileRequestMatch[0], '').trim();
        if (fileRequestMatch[1].toLowerCase() === 'pdf') {
            const pdfResult = await generatePdfFile(title, cleanContent);
            if (pdfResult.success) {
                return {
                    content: cleanContent, provider, success: true,
                    generatedFileBase64: pdfResult.fileBase64,
                    generatedFileMimeType: 'application/pdf',
                    generatedFileName: `${title}.pdf`,
                    groundingCitations
                };
            }
        }
        return { content: cleanContent, provider, success: true, groundingCitations };
    }

    return { content, provider, success: true, groundingCitations };
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
const editImage = async (prompt: string, imageDatas: string[], mimeTypes: string[], apiKey: string): Promise<AiResponse> => {
    try {
        const response = await axios.post(
            `${GOOGLE_AI_BASE_URL}/models/${IMAGE_EDIT_MODEL_ID}:generateContent?key=${apiKey}`,
            {
                contents: [{
                    // Gemini's generateContent accepts several inline_data image
                    // parts in one request — this is what lets a character
                    // reference image (or any extra attached image) actually
                    // influence the edit, instead of only ever seeing imageDatas[0].
                    parts: [
                        { text: prompt },
                        ...imageDatas.map((data, i) => ({ inline_data: { mime_type: mimeTypes[i] || 'image/jpeg', data } }))
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
const generateVideo = async (
    prompt: string, apiKey: string, startImageBase64?: string, endImageBase64?: string,
    durationSeconds?: number, aspectRatio?: string, resolution?: string
): Promise<AiResponse> => {
    try {
        const instance: any = { prompt };
        // Same mime-type convention as editImage/GeminiProvider.chat — imageDatas
        // doesn't carry its original mime type through the pipeline.
        if (startImageBase64) instance.image = { inlineData: { mimeType: 'image/jpeg', data: startImageBase64 } };
        if (endImageBase64) instance.lastFrame = { inlineData: { mimeType: 'image/jpeg', data: endImageBase64 } };

        // Real Veo 3.1 constraints (confirmed against Google's own docs, not
        // guessed): durationSeconds only accepts 4/6/8, aspectRatio only
        // 16:9/9:16, and 1080p/4k resolution REQUIRES an 8-second clip — a
        // request combining e.g. resolution=4k with durationSeconds=4 would
        // just fail server-side, so that combination is corrected here
        // rather than passed through broken.
        const parameters: any = { sampleCount: 1 };
        if (durationSeconds && [4, 6, 8].includes(durationSeconds)) parameters.durationSeconds = durationSeconds;
        if (aspectRatio && ['16:9', '9:16'].includes(aspectRatio)) parameters.aspectRatio = aspectRatio;
        if (resolution && ['720p', '1080p', '4k'].includes(resolution)) {
            parameters.resolution = resolution;
            if (resolution !== '720p') parameters.durationSeconds = 8;
        }

        const startResponse = await axios.post(
            `${GOOGLE_AI_BASE_URL}/models/${VIDEO_GEN_MODEL_ID}:predictLongRunning?key=${apiKey}`,
            { instances: [instance], parameters }
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
export const getAiResponse = async (
    prompt: string, provider: string, history: any[], user?: any, imageDatas?: string[],
    audioData?: string, videoData?: { base64: string, mimeType: string }, imageRoles?: string[],
    confirmArchRender?: boolean, archUnderstanding?: string, imageMimeTypes?: string[],
    videoDurationSeconds?: number, videoAspectRatio?: string, videoResolution?: string,
    imageStyle?: string
): Promise<AiResponse> => {
    const geminiKeyForGeneration = process.env.GEMINI_API_KEY;
    const styledImagePrompt = applyImageStyle(prompt, imageStyle);
    // Scene Mode's keyframe images, pulled out by role rather than position —
    // shared by every video path below (app's own Veo, BYOK video-edit, BYOK
    // video-gen) since all three can make use of a start/end/reference frame.
    const roleIndex = (role: string) => imageRoles?.indexOf(role) ?? -1;
    const startImageBase64 = imageDatas && roleIndex('start') >= 0 ? imageDatas[roleIndex('start')] : undefined;
    const endImageBase64 = imageDatas && roleIndex('end') >= 0 ? imageDatas[roleIndex('end')] : undefined;
    const referenceImageBase64 = imageDatas && roleIndex('character') >= 0 ? imageDatas[roleIndex('character')] : undefined;
    // Multi-face video targeting: a copy of a video frame with the specific
    // face to swap highlighted, so "swap only this one" has a visual pointer
    // instead of relying on "the main person" when several people are in shot.
    const faceTargetImageBase64 = imageDatas && roleIndex('face_target') >= 0 ? imageDatas[roleIndex('face_target')] : undefined;

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
            startImageBase64, endImageBase64, referenceImageBase64, faceTargetImageBase64, imageMimeType: 'image/jpeg',
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
    if (provider === 'pollinations') {
        return generatePollinationsImage(styledImagePrompt);
    }
    if (provider === 'huggingface') {
        return generateHuggingFaceImage(styledImagePrompt);
    }
    if (provider === 'huggingface-video') {
        return generateHuggingFaceVideo(styledImagePrompt);
    }
    if (provider === IMAGE_GEN_MODEL_ID) {
        // If free user (no ai_pro add-on), route to free Pollinations/HuggingFace engine
        const hasAiPro = user?.deviceId ? await hasAddon(user.deviceId, 'ai_pro') : false;
        if (!hasAiPro && !user?.activeImageGenConfigId) {
            logger.info('🎨 Free user image generation -> routing to Pollinations FLUX.1 free engine');
            return generatePollinationsImage(styledImagePrompt);
        }

        // If the user has a saved+active image-gen provider, use theirs
        if (user?.activeImageGenConfigId) {
            const config = await AiProviderConfig.findOne({ where: { id: user.activeImageGenConfigId, deviceId: user.deviceId } });
            if (config) {
                const apiKey = decrypt(config.encryptedKey);
                const result = await ImageGenProvider.generate({ prompt: styledImagePrompt, apiKey, baseUrl: config.baseUrl ?? undefined, modelName: config.modelName ?? undefined });
                if (!result.success) return { content: '', provider: `custom-image:${config.label}`, success: false, error: result.error };
                if (result.imageBase64) {
                    return { content: '', provider: `custom-image:${config.label}`, success: true, generatedImageBase64: result.imageBase64, generatedImageMimeType: 'image/png' };
                }
                return { content: '', provider: `custom-image:${config.label}`, success: true, generatedImageUrl: result.imageUrl };
            }
        }
        if (!geminiKeyForGeneration) return generatePollinationsImage(styledImagePrompt);
        return generateImage(styledImagePrompt, geminiKeyForGeneration);
    }
    if (provider === VIDEO_GEN_MODEL_ID) {
        // Mirrors IMAGE_GEN_MODEL_ID's hasAddon gate + free-engine fallback
        // just above — this branch was missing the gate entirely, so any
        // request with this provider id ran real (billed) Veo generation on
        // the app's own key regardless of tier. The client hid the option
        // from free users, but nothing server-side actually enforced that —
        // a direct/non-UI request could generate unlimited paid video for
        // free. BYOK still bypasses this, same as every other provider —
        // that's the user's own key, not ours.
        const hasAiProForVideo = user?.deviceId ? await hasAddon(user.deviceId, 'ai_pro') : false;
        if (!hasAiProForVideo && !user?.activeVideoGenConfigId) {
            logger.info('🎬 Free user video generation -> routing to Hugging Face free engine');
            return generateHuggingFaceVideo(styledImagePrompt);
        }
        if (user?.activeVideoGenConfigId) {
            const config = await AiProviderConfig.findOne({ where: { id: user.activeVideoGenConfigId, deviceId: user.deviceId } });
            if (config) {
                const apiKey = decrypt(config.encryptedKey);
                // Video gen providers vary even more than image ones — reusing the
                // video-edit adapter's generic shape here since both ultimately
                // need {prompt[, video]} in and a video out; a pure-generation call
                // just omits the source video.
                const result = await VideoEditProvider.edit({
                    prompt, apiKey, baseUrl: config.baseUrl ?? undefined, modelName: config.modelName ?? undefined,
                    startImageBase64, endImageBase64, referenceImageBase64, faceTargetImageBase64, imageMimeType: 'image/jpeg'
                });
                if (!result.success) return { content: '', provider: `custom-video:${config.label}`, success: false, error: result.error };
                const videoUrl = result.videoUrl || buildMediaUrl(storeMediaBase64(result.videoBase64!, 'video/mp4'));
                return { content: '', provider: `custom-video:${config.label}`, success: true, generatedVideoUrl: videoUrl };
            }
        }
        if (!geminiKeyForGeneration) return { content: '', provider, success: false, error: 'Video generation is not configured.' };
        return generateVideo(styledImagePrompt, geminiKeyForGeneration, startImageBase64, endImageBase64, videoDurationSeconds, videoAspectRatio, videoResolution);
    }
    if (provider === IMAGE_EDIT_MODEL_ID) {
        if (!geminiKeyForGeneration) return { content: '', provider, success: false, error: 'Image editing is not configured.' };
        if (!imageDatas || imageDatas.length === 0) return { content: '', provider, success: false, error: 'Attach an image to edit.' };
        // All attached images go through (not just imageDatas[0]) so a character
        // reference image can actually influence the edit.
        return editImage(prompt, imageDatas, imageDatas.map((_, i) => imageMimeTypes?.[i] || 'image/jpeg'), geminiKeyForGeneration);
    }
    const domainConfig = DOMAIN_CONFIGS[provider];
    if (domainConfig) {
        if (domainConfig.requiresAddon && (!user?.deviceId || !(await hasAddon(user.deviceId, domainConfig.requiresAddon)))) {
            return { content: '', provider, success: false, error: `${domainConfig.displayName} is a Mistreal Pro feature — unlock it in Settings.` };
        }
        if (!geminiKeyForGeneration) return { content: '', provider, success: false, error: `${domainConfig.displayName} is not configured.` };

        // Abuse-prevention safety valve, not a billing quota — see
        // domainRateLimiter.ts. Checked after the Pro gate (never blocks a
        // non-paying rejection early) and before spending a Gemini call.
        const limitError = checkDomainRateLimit(user?.deviceId ?? undefined);
        if (limitError) return { content: '', provider, success: false, error: limitError };

        // Always the app's own Gemini key, never the user's BYOK chat
        // provider — BYOK OpenAI/Anthropic silently drop image attachments
        // (see openAiCompatibleProvider.ts/anthropicProvider.ts), so this is
        // the only reliable way to actually read the user's sketch.
        const domainHistory = history.map((m: any) => ({ role: m.role, content: m.content }));
        const chatResult = await GeminiProvider.chat({
            systemInstruction: domainConfig.systemInstruction,
            history: domainHistory,
            prompt: confirmArchRender
                ? `${prompt}\n\n(The user confirmed this understanding and wants the image generated now: ${archUnderstanding || '{}'})`
                : prompt,
            apiKey: geminiKeyForGeneration,
            modelCandidates: await getRankedGeminiModels(true),
            imageDatas, imageMimeTypes, audioData
        });

        if (!chatResult.success) return { content: '', provider, success: false, error: chatResult.error };
        if (!confirmArchRender) return { content: chatResult.content, provider, success: true };

        // Confirmed — also render the image, reusing the same generate/edit
        // functions the ordinary image-gen/edit providers use. editImage when
        // the user's own sketch is available to riff on, generateImage
        // otherwise. Text + image both populate on this one response —
        // ChatViewModel.kt already turns each into its own message.
        let understanding: any = {};
        try { understanding = archUnderstanding ? JSON.parse(archUnderstanding) : {}; } catch { understanding = {}; }
        const renderPrompt = domainConfig.buildRenderPrompt(understanding, prompt);

        // Only real images (not PDFs) can feed the pixel-editing step — a
        // PDF informs the clarifying conversation but isn't something
        // editImage/Gemini's image-edit model can riff on.
        const sketchEntries = (imageDatas || [])
            .map((data, i) => ({ data, mimeType: imageMimeTypes?.[i] || 'image/jpeg' }))
            .filter(e => e.mimeType.startsWith('image/'));

        const imageResult = sketchEntries.length > 0
            ? await editImage(renderPrompt, sketchEntries.map(e => e.data), sketchEntries.map(e => e.mimeType), geminiKeyForGeneration)
            : await generateImage(renderPrompt, geminiKeyForGeneration);

        if (!imageResult.success) return { content: chatResult.content, provider, success: true, error: imageResult.error };
        return { ...imageResult, content: chatResult.content, provider };
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
    - If asked to draw, generate, or create an image, append "[INLINE_MEDIA: style=STYLE, prompt=DESCRIPTION]" to your response, where DESCRIPTION is a detailed rendering of what to draw and STYLE is one of: ${Object.keys(IMAGE_STYLE_DESCRIPTORS).join(', ')} (pick "realistic" if the user didn't ask for a specific style). Use this tag SILENTLY — the user only sees the resulting image, never the tag text.

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
                        modelId: user.byokModelName || undefined, imageDatas, imageMimeTypes, audioData
                    });
                    break;
                case 'openai_compatible':
                    result = await OpenAiCompatibleProvider.chat({
                        systemInstruction, history: byokHistory, prompt, apiKey,
                        modelId: user.byokModelName || undefined, baseUrl: user.byokBaseUrl || undefined,
                        imageDatas, imageMimeTypes, audioData
                    });
                    break;
                case 'anthropic':
                    result = await AnthropicProvider.chat({
                        systemInstruction, history: byokHistory, prompt, apiKey,
                        modelId: user.byokModelName || undefined, imageDatas, imageMimeTypes, audioData
                    });
                    break;
                case 'gemini':
                    result = await GeminiProvider.chat({
                        systemInstruction, history: byokHistory, prompt, apiKey,
                        modelCandidates: [user.byokModelName || 'gemini-1.5-flash'], imageDatas, imageMimeTypes, audioData
                    });
                    break;
                default:
                    return { content: '', provider: activeProvider, success: false, error: `Unknown BYOK provider type: ${user.byokProviderType}` };
            }

            if (!result.success) {
                return { content: '', provider: `byok:${user.byokProviderType}`, success: false, error: result.error };
            }
            return await attachGeneratedMedia(result.content, `byok:${user.byokProviderType}`, result.groundingCitations);
        } catch (error: any) {
            logger.error(`❌ BYOK execution error: ${error.message}`);
            return { content: '', provider: 'byok', success: false, error: error.message };
        }
    }

    // --- App-key path (curated models) — behavior preserved exactly ---

    if (isGoogleModel && geminiKey) {
        let targetModel = activeProvider === 'dynamic' ? "" : activeProvider;
        // Gated on the specific ai_pro add-on now, not the generic isPro flag
        // (which only means "has any add-on" — see addonService.ts).
        const hasAiPro = user?.deviceId ? await hasAddon(user.deviceId, 'ai_pro') : false;
        const rankedCandidates = await getRankedGeminiModels(hasAiPro);

        if (!targetModel || targetModel === 'dynamic') {
            targetModel = rankedCandidates[0] || "gemini-2.5-flash";
        }

        const modelsToTry: string[] = [targetModel];
        rankedCandidates.slice(0, 2).forEach((m: any) => {
            if (!modelsToTry.includes(m)) modelsToTry.push(m);
        });

        const geminiHistory = history.map((m: any) => ({ role: m.role, content: m.content }));
        const result = await GeminiProvider.chat({
            systemInstruction, history: geminiHistory, prompt, apiKey: geminiKey,
            modelCandidates: modelsToTry, imageDatas, imageMimeTypes, audioData
        });

        if (result.success) {
            return await attachGeneratedMedia(result.content, result.modelUsed, result.groundingCitations);
        }

        // 🚨 ULTIMATE EMERGENCY PIVOT: If all Google candidates fail, try OpenRouter as a bridge.
        if (openRouterKey) {
            logger.error(`🚨 Global Google failure. Pivoting to OpenRouter bridge...`);
            return await getAiResponse(prompt, 'google/gemini-2.0-flash-001', history, user, imageDatas, audioData);
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
        activeProvider === 'dynamic' || activeProvider.includes('gemini-flash') ? 'google/gemini-2.0-flash-001' : activeProvider,
        'meta-llama/llama-3.3-70b-instruct:free',
        'meta-llama/llama-3.1-8b-instruct:free',
        'deepseek/deepseek-r1:free',
        'google/gemini-2.0-flash-exp:free'
    ];

    const orHistory = history.map((m: any) => ({ role: m.role, content: m.content }));
    const orResult = await OpenRouterProvider.chat({
        systemInstruction, history: orHistory, prompt, apiKey: openRouterKey, modelCandidates: orModels
    });

    if (orResult.success) {
        return await attachGeneratedMedia(orResult.content, orResult.modelUsed);
    }

    // Mirror the Gemini->OpenRouter emergency pivot in the other direction —
    // OpenRouter's free catalog rotates/deprecates models often, so a selected
    // free model id (or every item in the fallback chain) can go stale and dead-end
    // the whole request with nothing to show, even though the app's own Gemini key
    // could still answer. Guard against infinite recursion since isGoogleModel
    // already short-circuits normal Gemini-model requests above this branch.
    if (geminiKey && isGoogleModel === false && activeProvider !== 'gemini-1.5-flash') {
        logger.error(`🚨 Global OpenRouter failure (${orResult.error}). Pivoting to Gemini bridge...`);
        return await getAiResponse(prompt, 'gemini-1.5-flash', history, user, imageDatas, audioData);
    }

    return { content: '', provider: activeProvider, success: false, error: orResult.error };
};
