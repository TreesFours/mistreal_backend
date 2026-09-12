import { Router, Request, Response } from 'express';
import { User } from '../models/userModel';
import { validate, userSettingsSchema } from '../middleware/validationMiddleware';
import { authenticateUser } from '../utils/authMiddleware';

const router = Router();

/**
 * 🛡️ STRATEGIC USER RESOLUTION
 */
const getResolvedUser = async (req: any) => {
    const firebaseUid = req.user?.uid;

    if (!firebaseUid) return null;

    try {
        let user = await User.findOne({ where: { firebaseUid } });
        if (user) return user;

        const deviceId = (req.query.deviceId || req.body.deviceId) as string;
        return await User.create({ firebaseUid, deviceId: deviceId || null, isPro: false });
    } catch (e) {
        return null;
    }
};

// ⚙️ Update User Settings
router.post('/settings', authenticateUser, validate(userSettingsSchema), async (req: Request, res: Response) => {
    try {
        const user = await getResolvedUser(req);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        const { userName, aiPersona, autoReplyDelay, guardianEnabled, emergencyContacts } = req.body;

        if (userName !== undefined) user.userName = userName;
        if (aiPersona !== undefined) user.aiPersona = aiPersona;
        if (autoReplyDelay !== undefined) user.autoReplyDelay = autoReplyDelay;
        if (guardianEnabled !== undefined) user.guardianEnabled = guardianEnabled;
        if (emergencyContacts !== undefined) user.emergencyContacts = emergencyContacts;

        await user.save();
        res.json({ success: true, message: 'Settings secured successfully' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
