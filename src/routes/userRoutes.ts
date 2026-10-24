import { Router, Request, Response } from 'express';
import { User } from '../models/userModel';
import { validate, userSettingsSchema } from '../middleware/validationMiddleware';
import { authenticateUser } from '../utils/authMiddleware';
import logger from '../utils/logger';

const router = Router();

/**
 * Registers/refreshes this device's FCM token — used to wake a backgrounded
 * app for an incoming call (see callSignalingService.ts's sendPushToDevice).
 * Device-keyed like the rest of the app's non-social-auth endpoints
 * (business/meetup/review routes), not gated behind authenticateUser, since
 * a user doesn't need to be Firebase-signed-in to receive a call.
 *
 * Deliberately plain findOne, NOT getOrCreateUserInternal: that helper's
 * firebaseUid-driven "repair" path reassigns deviceId onto an existing
 * firebaseUid-matched row, which would let whoever can read/guess a
 * victim's firebaseUid hijack their account's deviceId through this
 * endpoint. That reassignment behavior is a pre-existing, app-wide trust
 * decision shared by many other routes already — not something to silently
 * change here — but this endpoint has no actual need for it: by the time a
 * device registers a push token, it has already hit some other endpoint
 * that created its User row, so there's nothing to create here, and
 * sidestepping the helper closes this one additional attack surface for it.
 */
router.post('/fcm-token', async (req: Request, res: Response) => {
    try {
        const { deviceId, fcmToken } = req.body;
        if (!deviceId || !fcmToken) {
            return res.status(200).json({ success: false, error: 'deviceId and fcmToken are required' });
        }
        const user = await User.findOne({ where: { deviceId } });
        if (!user) return res.status(200).json({ success: false, error: 'User not found for this device' });
        user.fcmToken = fcmToken;
        await user.save();
        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ POST /users/fcm-token error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

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

        const { userName, aiPersona, autoReplyDelay, guardianEnabled, aiAutoSendEnabled } = req.body;

        if (userName !== undefined) user.userName = userName;
        if (aiPersona !== undefined) user.aiPersona = aiPersona;
        if (autoReplyDelay !== undefined) user.autoReplyDelay = autoReplyDelay;
        if (guardianEnabled !== undefined) user.guardianEnabled = guardianEnabled;
        if (aiAutoSendEnabled !== undefined) user.aiAutoSendEnabled = aiAutoSendEnabled;

        await user.save();
        res.json({ success: true, message: 'Settings secured successfully' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ⚙️ Read back current settings (server-confirmed source of truth — e.g. the
// AI auto-send toggle must not be gated by a client-only flag the user could
// bypass by reinstalling with a stale local cache).
router.get('/settings', authenticateUser, async (req: Request, res: Response) => {
    try {
        const user = await getResolvedUser(req);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        res.json({
            success: true,
            userName: user.userName,
            aiPersona: user.aiPersona,
            autoReplyDelay: user.autoReplyDelay,
            guardianEnabled: user.guardianEnabled,
            aiAutoSendEnabled: user.aiAutoSendEnabled
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
