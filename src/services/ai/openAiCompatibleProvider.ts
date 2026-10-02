import axios from 'axios';
import logger from '../../utils/logger';
import { AiProvider, ProviderChatRequest, ProviderChatResponse } from './types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 20000;

/**
 * BYOK-only. Covers OpenAI itself (default base URL) and any OpenAI-compatible
 * third party via a user-supplied base URL. Single model, no failover — this is
 * the user's own key, so silently trying a different model they didn't choose
 * would be wrong. Text-only for now: "compatible" backends vary too much in
 * their multimodal payload shape to safely generalize image/audio input yet.
 */
export const OpenAiCompatibleProvider: AiProvider = {
    id: 'openai_compatible',
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
        const modelId = req.modelId || 'gpt-4o-mini';
        const baseUrl = (req.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');

        if (req.imageDatas?.length || req.audioData) {
            logger.warn('⚠️ OpenAiCompatibleProvider: attachment present but BYOK text-only in this version — proceeding without it.');
        }

        try {
            const response = await axios.post(`${baseUrl}/chat/completions`, {
                model: modelId,
                messages: [
                    { role: 'system', content: req.systemInstruction },
                    ...req.history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
                    { role: 'user', content: req.prompt }
                ]
            }, {
                headers: { 'Authorization': `Bearer ${req.apiKey}` },
                timeout: REQUEST_TIMEOUT_MS,
                validateStatus: () => true
            });

            if (response.status === 200 && response.data?.choices?.[0]?.message?.content) {
                return { content: response.data.choices[0].message.content, modelUsed: modelId, success: true };
            }

            const remoteError = response.data?.error?.message || response.statusText;
            return { content: '', modelUsed: modelId, success: false, error: `[HTTP ${response.status}] ${remoteError}` };
        } catch (error: any) {
            logger.error(`❌ OpenAI-compatible provider error: ${error.message}`);
            return { content: '', modelUsed: modelId, success: false, error: error.message };
        }
    }
};
