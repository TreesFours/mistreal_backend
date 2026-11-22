import axios from 'axios';
import logger from '../../utils/logger';

const DEFAULT_ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

export interface VoiceCloneCreateResult {
    success: boolean;
    voiceId?: string;
    error?: string;
}

export interface VoiceSynthesizeResult {
    success: boolean;
    audioBuffer?: Buffer;
    mimeType?: string;
    error?: string;
}

/**
 * ElevenLabs voice cloning + text-to-speech — endpoint shapes here are
 * UNVERIFIED against their live docs this session (unlike every Zernio
 * endpoint elsewhere in this codebase, which got checked against their real
 * OpenAPI spec before being written); this follows ElevenLabs' long-stable,
 * widely-documented public API from general knowledge. Flagging explicitly
 * rather than implying the same confidence level as the Zernio work — worth
 * a real test call once a real ElevenLabs key is available.
 *
 * 'custom' providerType gets a best-effort generic shape, same "convention,
 * not a guarantee" caveat as VideoEditProvider's 'custom' path — there's no
 * standard voice-cloning API shape across providers the way there's a
 * rough standard for OpenAI-compatible chat.
 */
export const VoiceCloneProvider = {
    /**
     * Creates a new cloned voice from one audio sample. Uses Node's native
     * fetch + FormData (not axios) specifically for this multipart call —
     * axios's Node adapter has historically needed the separate `form-data`
     * npm package (not a dependency here) to build multipart bodies
     * correctly, while native fetch/FormData (global since Node 18) handles
     * the multipart boundary itself with no extra package.
     */
    createClone: async (
        providerType: string,
        apiKey: string,
        baseUrl: string | null,
        name: string,
        audioBuffer: Buffer,
        mimeType: string
    ): Promise<VoiceCloneCreateResult> => {
        const effectiveBaseUrl = baseUrl || DEFAULT_ELEVENLABS_BASE_URL;
        try {
            if (providerType === 'elevenlabs') {
                const form = new FormData();
                form.append('name', name);
                form.append('files', new Blob([audioBuffer], { type: mimeType }), 'sample.mp3');

                const response = await fetch(`${effectiveBaseUrl}/v1/voices/add`, {
                    method: 'POST',
                    headers: { 'xi-api-key': apiKey },
                    body: form
                });
                if (!response.ok) {
                    const body = await response.text().catch(() => '');
                    throw new Error(`ElevenLabs voice creation failed (${response.status}): ${body}`);
                }
                const data: any = await response.json();
                const voiceId = data?.voice_id;
                if (!voiceId) return { success: false, error: 'ElevenLabs returned no voice_id.' };
                return { success: true, voiceId };
            }

            // 'custom' — best-effort generic multipart shape, same caveat as above.
            const form = new FormData();
            form.append('name', name);
            form.append('files', new Blob([audioBuffer], { type: mimeType }), 'sample.mp3');
            const response = await fetch(`${effectiveBaseUrl}/voices/add`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}` },
                body: form
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`Custom voice-clone provider failed (${response.status}): ${body}`);
            }
            const data: any = await response.json();
            const voiceId = data?.voice_id || data?.voiceId || data?.id;
            if (!voiceId) return { success: false, error: 'Provider returned no voice id — check the response shape matches voice_id/voiceId/id.' };
            return { success: true, voiceId };
        } catch (error: any) {
            logger.error('❌ Voice clone creation failed:', error.message);
            return { success: false, error: error.message };
        }
    },

    synthesize: async (
        providerType: string,
        apiKey: string,
        baseUrl: string | null,
        voiceId: string,
        text: string,
        modelName: string | null
    ): Promise<VoiceSynthesizeResult> => {
        const effectiveBaseUrl = baseUrl || DEFAULT_ELEVENLABS_BASE_URL;
        try {
            if (providerType === 'elevenlabs') {
                const response = await axios.post(
                    `${effectiveBaseUrl}/v1/text-to-speech/${voiceId}`,
                    { text, model_id: modelName || DEFAULT_MODEL_ID },
                    {
                        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
                        responseType: 'arraybuffer',
                        timeout: 60000
                    }
                );
                return { success: true, audioBuffer: Buffer.from(response.data), mimeType: 'audio/mpeg' };
            }

            // 'custom' — best-effort: expects raw audio bytes back too.
            const response = await axios.post(
                `${effectiveBaseUrl}/text-to-speech/${voiceId}`,
                { text, model: modelName },
                {
                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    responseType: 'arraybuffer',
                    timeout: 60000
                }
            );
            return { success: true, audioBuffer: Buffer.from(response.data), mimeType: 'audio/mpeg' };
        } catch (error: any) {
            const detail = error.response?.data ? Buffer.from(error.response.data).toString('utf8').slice(0, 300) : error.message;
            logger.error('❌ Voice synthesis failed:', detail);
            return { success: false, error: detail };
        }
    },

    deleteVoice: async (providerType: string, apiKey: string, baseUrl: string | null, voiceId: string): Promise<void> => {
        const effectiveBaseUrl = baseUrl || DEFAULT_ELEVENLABS_BASE_URL;
        const path = providerType === 'elevenlabs' ? `/v1/voices/${voiceId}` : `/voices/${voiceId}`;
        const headerName = providerType === 'elevenlabs' ? 'xi-api-key' : 'Authorization';
        const headerValue = providerType === 'elevenlabs' ? apiKey : `Bearer ${apiKey}`;
        try {
            await axios.delete(`${effectiveBaseUrl}${path}`, { headers: { [headerName]: headerValue }, timeout: 30000 });
        } catch (error: any) {
            // Best-effort cleanup — a failure here shouldn't block the user from
            // clearing their local key/clone reference regardless.
            logger.warn('⚠️ Remote voice deletion failed (local reference cleared anyway):', error.response?.data || error.message);
        }
    }
};
