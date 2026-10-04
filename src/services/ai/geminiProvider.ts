import axios from 'axios';
import logger from '../../utils/logger';
import { AiProvider, ProviderChatRequest, ProviderChatResponse } from './types';

const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Calls Gemini's generateContent REST API directly. Tries each model in
 * `modelCandidates` in order (curated/app-key path provides a ranked failover
 * list; BYOK callers pass a single-element list — no cross-model failover for
 * a user's own key/model choice).
 */
export const GeminiProvider: AiProvider = {
    id: 'google',
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
        const candidates = req.modelCandidates && req.modelCandidates.length > 0
            ? req.modelCandidates
            : (req.modelId ? [req.modelId] : []);

        if (candidates.length === 0) {
            return { content: '', modelUsed: '', success: false, error: 'No Gemini model specified.' };
        }

        let lastError = '';

        for (const targetModel of candidates) {
            try {
                const cleanModelName = targetModel.replace('models/', '').replace('google/', '').trim();

                logger.info(`🤖 Intelligence Routing: Attempting ${cleanModelName}`);

                const contents = req.history.map((m) => ({
                    role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }));

                const currentParts: any[] = [{ text: req.prompt }];
                if (req.imageDatas) req.imageDatas.forEach((d) => currentParts.push({ inline_data: { mime_type: 'image/jpeg', data: d } }));
                // The app's recorder actually produces AAC audio (M4A container), not MP3 —
                // telling Gemini it's audio/mp3 when the bytes are AAC risks it failing to
                // decode the clip correctly.
                if (req.audioData) currentParts.push({ inline_data: { mime_type: 'audio/aac', data: req.audioData } });
                contents.push({ role: 'user', parts: currentParts });

                const url = `${GOOGLE_AI_BASE_URL}/models/${cleanModelName}:generateContent?key=${req.apiKey}`;
                logger.info(`📡 AI Direct Execution: ${cleanModelName}`);

                const response = await axios.post(url, {
                    contents,
                    system_instruction: { parts: [{ text: req.systemInstruction }] },
                    tools: [{
                        google_search_retrieval: {
                            dynamic_retrieval_config: { mode: 'MODE_DYNAMIC', dynamic_threshold: 0.3 }
                        }
                    }]
                }, {
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: () => true
                });

                if (response.status === 200 && response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                    return {
                        content: response.data.candidates[0].content.parts[0].text,
                        modelUsed: targetModel,
                        success: true
                    };
                }

                const remoteError = response.data?.error?.message || response.statusText;
                lastError = `[HTTP ${response.status}] ${remoteError}`;
                logger.error(`❌ Gemini API Failure [${cleanModelName}]: ${lastError}`);

                if (response.status === 404) {
                    lastError = `ENDPOINT_NOT_FOUND: The model name '${cleanModelName}' might be incorrect for your API key region.`;
                }
            } catch (error: any) {
                lastError = error.message;
                logger.error(`❌ Gemini Network/Axios Error: ${lastError}`);
            }
        }

        return { content: '', modelUsed: '', success: false, error: lastError };
    }
};
