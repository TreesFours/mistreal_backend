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
    })
});

export const userSettingsSchema = z.object({
    body: z.object({
        deviceId: z.string({ required_error: "deviceId is required" }),
        userName: z.string().optional(),
        aiPersona: z.string().optional(),
        autoReplyDelay: z.number().optional(),
        guardianEnabled: z.boolean().optional(),
        emergencyContacts: z.array(z.any()).optional(),
    })
});
