import axios from 'axios';
import logger from '../../utils/logger';
import { AiProvider, ProviderChatRequest, ProviderChatResponse } from './types';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 20000;

/**
 * BYOK-only. Anthropic's Messages API separates `system` from `messages`
 * (unlike the OpenAI-shaped providers, which fold system into the messages
 * array) — hence its own implementation rather than reuse of
 * OpenAiCompatibleProvider. Single model, no failover (user's own key).
 *
 * Images use Anthropic's documented base64 image content block
 * ({type:"image", source:{type:"base64", media_type, data}}) mixed into the
 * same content array as the text part — real vision input, not a silent
 * drop, matching what GeminiProvider already does for the app-key path.
 *
 * Live search parity with Gemini's always-on google_search_retrieval: every
 * request carries Anthropic's own native web_search tool
 * (web_search_20250305) — Claude decides for itself whether a given prompt
 * needs it. Billed through the user's own Anthropic key like any other BYOK
 * usage, same separation as every other BYOK cost in this app.
 */
export const AnthropicProvider: AiProvider = {
    id: 'anthropic',
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
        const modelId = req.modelId || 'claude-3-5-sonnet-20241022';

        if (req.audioData) {
            logger.warn('⚠️ AnthropicProvider: audio attachment present but unsupported in this version — proceeding without it.');
        }

        const currentContent: any = req.imageDatas?.length
            ? [
                { type: 'text', text: req.prompt },
                ...req.imageDatas.map((data, i) => ({
                    type: 'image',
                    source: { type: 'base64', media_type: req.imageMimeTypes?.[i] || 'image/jpeg', data }
                }))
            ]
            : req.prompt;

        try {
            const response = await axios.post(ANTHROPIC_API_URL, {
                model: modelId,
                system: req.systemInstruction,
                max_tokens: 4096,
                tools: [{ type: 'web_search_20250305', name: 'web_search' }],
                messages: [
                    ...req.history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
                    { role: 'user', content: currentContent }
                ]
            }, {
                headers: {
                    'x-api-key': req.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'content-type': 'application/json'
                },
                timeout: REQUEST_TIMEOUT_MS,
                validateStatus: () => true
            });

            // With web_search active, content can interleave server_tool_use /
            // web_search_tool_result blocks with text blocks — content[0] isn't
            // reliably the answer any more, so collect every text block instead.
            const blocks: any[] = response.data?.content;
            if (response.status === 200 && Array.isArray(blocks) && blocks.length > 0) {
                const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
                if (text) return { content: text, modelUsed: modelId, success: true };
            }

            const remoteError = response.data?.error?.message || response.statusText;
            return { content: '', modelUsed: modelId, success: false, error: `[HTTP ${response.status}] ${remoteError}` };
        } catch (error: any) {
            logger.error(`❌ Anthropic provider error: ${error.message}`);
            return { content: '', modelUsed: modelId, success: false, error: error.message };
        }
    }
};
