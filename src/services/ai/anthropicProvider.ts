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
 */
export const AnthropicProvider: AiProvider = {
    id: 'anthropic',
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
        const modelId = req.modelId || 'claude-3-5-sonnet-20241022';

        if (req.imageDatas?.length || req.audioData) {
            logger.warn('⚠️ AnthropicProvider: attachment present but BYOK text-only in this version — proceeding without it.');
        }

        try {
            const response = await axios.post(ANTHROPIC_API_URL, {
                model: modelId,
                system: req.systemInstruction,
                max_tokens: 4096,
                messages: [
                    ...req.history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
                    { role: 'user', content: req.prompt }
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

            if (response.status === 200 && response.data?.content?.[0]?.text) {
                return { content: response.data.content[0].text, modelUsed: modelId, success: true };
            }

            const remoteError = response.data?.error?.message || response.statusText;
            return { content: '', modelUsed: modelId, success: false, error: `[HTTP ${response.status}] ${remoteError}` };
        } catch (error: any) {
            logger.error(`❌ Anthropic provider error: ${error.message}`);
            return { content: '', modelUsed: modelId, success: false, error: error.message };
        }
    }
};
