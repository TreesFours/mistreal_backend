import { Router, Request, Response } from 'express';
import { User } from '../models/userModel';
import { validate, userSettingsSchema } from '../middleware/validationMiddleware';

const router = Router();

// 🛡️ Helper: Get or Create User
const getOrCreateUser = async (deviceId: string) => {
    try {
        const [user, created] = await User.findOrCreate({
            where: { deviceId },
            defaults: {
                deviceId,
                isPro: false,
                subscriptionTier: 'free'
            }
        });
        if (created) console.log(`🆕 New user registered: ${deviceId}`);
        return user;
    } catch (e) {
        console.error(`❌ Error finding/creating user ${deviceId}:`, e);
        return null;
    }
};

// ⚙️ Update User Settings
router.post('/settings', validate(userSettingsSchema), async (req: Request, res: Response) => {
    const { deviceId, userName, aiPersona, autoReplyDelay, guardianEnabled, emergencyContacts } = req.body;

    try {
        const user = await getOrCreateUser(deviceId);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        if (userName !== undefined) user.userName = userName;
        if (aiPersona !== undefined) user.aiPersona = aiPersona;
        if (autoReplyDelay !== undefined) user.autoReplyDelay = autoReplyDelay;
        if (guardianEnabled !== undefined) user.guardianEnabled = guardianEnabled;
        if (emergencyContacts !== undefined) user.emergencyContacts = emergencyContacts;

        await user.save();
        res.json({ success: true, message: 'Settings secured successfully' });
    } catch (error: any) {
        console.error(`❌ Error updating settings for ${deviceId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
