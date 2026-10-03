import axios from 'axios';
import logger from '../../utils/logger';

export interface ImageGenRequest {
    prompt: string;
    apiKey: string;
    baseUrl?: string;
    modelName?: string;
}

export interface ImageGenResponse {
    success: boolean;
    imageUrl?: string;
    imageBase64?: string;
    error?: string;
}

/**
 * Generic REST adapter for a user-supplied image-generation provider (OpenAI
 * DALL-E, Stability, or any "custom" endpoint). UNVERIFIED payload shape, same
 * caveat as videoEditProvider.ts — image-gen APIs don't share one standard
 * request format, so this sends the most common-sense convention ({ prompt,
 * model } in, imageUrl/imageBase64 out) and the user's baseUrl is expected to
 * point at something that speaks this shape (a small proxy in front of the
 * real provider if it differs).
 */
export const ImageGenProvider = {
    generate: async (req: ImageGenRequest): Promise<ImageGenResponse> => {
        if (!req.baseUrl) {
            return { success: false, error: 'No image generation endpoint configured.' };
        }
        try {
            const response = await axios.post(
                req.baseUrl,
                { prompt: req.prompt, model: req.modelName },
                { headers: { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
            );
            const data = response.data;
            if (data?.imageUrl) return { success: true, imageUrl: data.imageUrl };
            if (data?.imageBase64) return { success: true, imageBase64: data.imageBase64 };
            return { success: false, error: 'Provider returned no image — check the response shape matches imageUrl/imageBase64.' };
        } catch (error: any) {
            logger.error('❌ BYOK image generation failed:', error.response?.data || error.message);
            return { success: false, error: error.response?.data?.error || error.message };
        }
    }
};
