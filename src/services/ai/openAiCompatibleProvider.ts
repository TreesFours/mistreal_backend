import axios from 'axios';
import logger from '../../utils/logger';
import { AiProvider, ProviderChatRequest, ProviderChatResponse } from './types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 20000;

/**
 * BYOK-only. Covers OpenAI itself (default base URL) and any OpenAI-compatible
 * third party via a user-supplied base URL. Single model, no failover — this is
 * the user's own key, so silently trying a different model they didn't choose
 * would be wrong.
 *
 * Images use the standard OpenAI Chat Completions vision format (a
 * content-array message with `image_url: {url: "data:<mime>;base64,<data>"}`
 * parts) — this shape is what OpenAI itself and the large majority of
 * "OpenAI-compatible" third parties actually implement, so it's safe to
 * generalize unlike audio (see below). If the user's chosen model doesn't
 * support vision, the provider will just reject the request with a real
 * error instead of us silently dropping the image first.
 *
 * Audio stays unsupported: OpenAI's own input_audio format is model-gated
 * (gpt-4o-audio-preview etc.) and "compatible" backends vary far more on
 * this than on vision, so still proceeding text-only is deliberate here.
 */
export const OpenAiCompatibleProvider: AiProvider = {
    id: 'openai_compatible',
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
        const modelId = req.modelId || 'gpt-4o-mini';
        const baseUrl = (req.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');

        if (req.audioData) {
            logger.warn('⚠️ OpenAiCompatibleProvider: audio attachment present but unsupported in this version — proceeding without it.');
        }

        const currentContent: any = req.imageDatas?.length
            ? [
                { type: 'text', text: req.prompt },
                ...req.imageDatas.map((data, i) => ({
                    type: 'image_url',
                    image_url: { url: `data:${req.imageMimeTypes?.[i] || 'image/jpeg'};base64,${data}` }
                }))
            ]
            : req.prompt;

        try {
            const response = await axios.post(`${baseUrl}/chat/completions`, {
                model: modelId,
                messages: [
                    { role: 'system', content: req.systemInstruction },
                    ...req.history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
                    { role: 'user', content: currentContent }
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
