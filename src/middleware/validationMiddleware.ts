import { Request, Response, NextFunction } from 'express';
// Note: Zod will be available on the user's Render environment.
// For now, I'm writing the code as if it's installed.
import { z, ZodError } from 'zod';

export const validate = (schema: z.ZodObject<any, any>) => {
    return (req: Request, res: Response, next: NextFunction) => {
        try {
            schema.parse({
                body: req.body,
                query: req.query,
                params: req.params,
            });
            next();
        } catch (error) {
            if (error instanceof ZodError) {
                return res.status(400).json({
                    success: false,
                    error: "Validation Failed",
                    details: error.errors.map(e => ({ path: e.path, message: e.message }))
                });
            }
            next(error);
        }
    };
};

// --- Schemas ---

export const chatSchema = z.object({
    body: z.object({
        prompt: z.string().optional(),
        provider: z.string().optional(),
        deviceId: z.string({ required_error: "deviceId is required" }),
        firebaseUid: z.string().optional(),
        history: z.union([z.string(), z.array(z.any())]).optional(),
        contextMetadata: z.string().optional(),
    }).refine(data => data.prompt || data.history, {
        message: "Either prompt or history (for voice) must be provided",
    })
});

export const socialActionSchema = z.object({
    body: z.object({
        deviceId: z.string({ required_error: "deviceId is required" }),
        type: z.string({ required_error: "Action type is required" }),
        platform: z.string({ required_error: "Platform is required" }),
        content: z.string({ required_error: "Content is required" }),
        targetId: z.string().optional(),
        mediaBase64: z.string().optional(),
        mediaMimeType: z.string().optional(),
        shareToCommunity: z.boolean().optional(),
    })
});

export const userSettingsSchema = z.object({
    body: z.object({
        deviceId: z.string({ required_error: "deviceId is required" }),
        firebaseUid: z.string().optional(),
        userName: z.string().optional(),
        aiPersona: z.string().optional(),
        autoReplyDelay: z.number().optional(),
        guardianEnabled: z.boolean().optional(),
        emergencyContacts: z.array(z.any()).optional(),
        aiAutoSendEnabled: z.boolean().optional(),
    })
});

export const byokKeySchema = z.object({
    body: z.object({
        deviceId: z.string({ required_error: "deviceId is required" }),
        firebaseUid: z.string().optional(),
        providerType: z.enum(['openai', 'anthropic', 'gemini', 'openai_compatible'], {
            required_error: "providerType is required"
        }),
        apiKey: z.string({ required_error: "apiKey is required" }).min(10, "apiKey looks too short to be valid"),
        baseUrl: z.string().url().optional(),
        modelName: z.string().optional(),
    })
});

export const byokClearSchema = z.object({
    body: z.object({
        deviceId: z.string({ required_error: "deviceId is required" }),
        firebaseUid: z.string().optional(),
    })
});

// Separate from byokKeySchema above — video editing is its own BYOK slot
// (see userModel.ts byokVideo* fields), not an extra providerType value on
// the text/chat one, since a user might run both at once.
export const byokVideoKeySchema = z.object({
    body: z.object({
        deviceId: z.string({ required_error: "deviceId is required" }),
        firebaseUid: z.string().optional(),
        providerType: z.enum(['runway', 'custom'], {
            required_error: "providerType is required"
        }),
        apiKey: z.string({ required_error: "apiKey is required" }).min(10, "apiKey looks too short to be valid"),
        baseUrl: z.string().url().optional(),
        modelName: z.string().optional(),
    })
});

// Saved image/video GENERATION provider configs — a user can add several and
// switch which is active, unlike the single-slot BYOK schemas above.
export const mediaProviderConfigSchema = z.object({
    body: z.object({
        deviceId: z.string({ required_error: "deviceId is required" }),
        firebaseUid: z.string().optional(),
        capability: z.enum(['image_gen', 'video_gen'], { required_error: "capability is required" }),
        label: z.string({ required_error: "label is required" }).min(1).max(60),
        providerType: z.string({ required_error: "providerType is required" }),
        apiKey: z.string({ required_error: "apiKey is required" }).min(10, "apiKey looks too short to be valid"),
        baseUrl: z.string().url({ message: "baseUrl must be a valid URL" }),
        modelName: z.string().optional(),
    })
});

export const mediaProviderActivateSchema = z.object({
    body: z.object({
        deviceId: z.string({ required_error: "deviceId is required" }),
        firebaseUid: z.string().optional(),
        capability: z.enum(['image_gen', 'video_gen'], { required_error: "capability is required" }),
        configId: z.number().nullable().optional(), // null/omitted = "Our Recommended"
    })
});
