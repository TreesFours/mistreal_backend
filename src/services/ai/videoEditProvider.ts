import axios from 'axios';
import logger from '../../utils/logger';

export interface VideoEditRequest {
    prompt: string;
    // Omitted (undefined) for a pure-generation call reusing this same adapter
    // (no source video to edit) — see getAiResponse's VIDEO_GEN_MODEL_ID branch.
    videoBase64?: string;
    mimeType?: string;
    // Scene Mode's keyframe conditioning — forwarded best-effort for whichever
    // BYOK provider the user configured; not every provider will honor these
    // (see the adapter note below), same "convention, not a guarantee" caveat
    // as the rest of this generic shape.
    startImageBase64?: string;
    endImageBase64?: string;
    referenceImageBase64?: string;
    imageMimeType?: string;
    apiKey: string;
    baseUrl?: string;
    modelName?: string;
}

export interface VideoEditResponse {
    success: boolean;
    videoUrl?: string;
    videoBase64?: string;
    error?: string;
}

/**
 * Generic REST adapter for a user-supplied video-editing provider (Runway or
 * any other "custom" endpoint). UNVERIFIED payload shape: real video-editing
 * APIs (Runway's Gen-3/Aleph, Pika, etc.) don't share one standard request
 * format the way OpenAI-compatible chat APIs loosely do, so this sends the
 * most common-sense convention — { prompt, video: base64, model } in, expect
 * either a videoUrl or videoBase64 back — and the user's `baseUrl` is
 * expected to point at an endpoint that speaks this shape (e.g. a small
 * proxy in front of their actual provider if the raw API differs). Document
 * this clearly in the Settings UI rather than pretend every provider just
 * works out of the box.
 */
export const VideoEditProvider = {
    edit: async (req: VideoEditRequest): Promise<VideoEditResponse> => {
        if (!req.baseUrl) {
            return { success: false, error: 'No video provider endpoint configured.' };
        }
        try {
            const body: any = { prompt: req.prompt, model: req.modelName };
            if (req.videoBase64) {
                body.video = req.videoBase64;
                body.mimeType = req.mimeType;
            }
            if (req.startImageBase64) body.startImage = { data: req.startImageBase64, mimeType: req.imageMimeType };
            if (req.endImageBase64) body.endImage = { data: req.endImageBase64, mimeType: req.imageMimeType };
            if (req.referenceImageBase64) body.referenceImage = { data: req.referenceImageBase64, mimeType: req.imageMimeType };
            const response = await axios.post(
                req.baseUrl,
                body,
                {
                    headers: { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' },
                    timeout: 120000
                }
            );
            const data = response.data;
            if (data?.videoUrl) return { success: true, videoUrl: data.videoUrl };
            if (data?.videoBase64) return { success: true, videoBase64: data.videoBase64 };
            return { success: false, error: 'Provider returned no video — check the response shape matches videoUrl/videoBase64.' };
        } catch (error: any) {
            logger.error('❌ BYOK video edit failed:', error.response?.data || error.message);
            return { success: false, error: error.response?.data?.error || error.message };
        }
    }
};
