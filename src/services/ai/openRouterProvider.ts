import axios from 'axios';
import logger from '../../utils/logger';
import { AiProvider, ProviderChatRequest, ProviderChatResponse } from './types';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 15000;

/** App-key path only (curated models) — BYOK never uses OpenRouter as a provider type. */
export const OpenRouterProvider: AiProvider = {
    id: 'openrouter',
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
        const candidates = req.modelCandidates && req.modelCandidates.length > 0
            ? req.modelCandidates
            : (req.modelId ? [req.modelId] : []);

        let lastError = '';

        for (const modelId of candidates) {
            try {
                const response = await axios.post(OPENROUTER_API_URL, {
                    model: modelId,
                    messages: [
                        { role: 'system', content: req.systemInstruction },
                        ...req.history.map((m) => ({ role: m.role, content: m.content })),
                        { role: 'user', content: req.prompt }
                    ]
                }, {
                    headers: {
                        'Authorization': `Bearer ${req.apiKey}`,
                        'HTTP-Referer': 'https://mistreal-assistant.com',
                        'X-Title': 'Mistreal Assistant'
                    },
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: (status) => status < 500
                });

                if (response.status === 200 && response.data?.choices?.[0]?.message?.content) {
                    return {
                        content: response.data.choices[0].message.content,
                        modelUsed: `openrouter/${modelId}`,
                        success: true
                    };
                }

                lastError = response.data?.error?.message || `HTTP ${response.status}`;
                logger.warn(`⚠️ OpenRouter Model ${modelId} failed: ${lastError}`);
            } catch (error: any) {
                lastError = error.message;
                logger.error(`❌ OpenRouter Connection Error [${modelId}]: ${lastError}`);
            }
        }

        return {
            content: '',
            modelUsed: '',
            success: false,
            error: `PROVIDER_ERROR: ${lastError} (Checked ${candidates.length} models)`
        };
    }
};
