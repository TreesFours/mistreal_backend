import * as admin from 'firebase-admin';
import { User } from '../models/userModel';
import logger from './logger';

/**
 * Wakes a specific device via FCM — the only way to reach an
 * app that's backgrounded/killed, since there's no other server-initiated
 * channel in this app (everything else is socket-connected-only or
 * next-time-you-open-it polling). Data-only message (no `notification`
 * block) so the client's FirebaseMessagingService always gets to decide
 * how to present it (e.g. a CallStyle notification for an incoming call)
 * rather than the OS auto-displaying a generic one while the app is
 * foregrounded too.
 *
 * Callers should treat a `false` return as "the callee can't be woken" —
 * not fatal, since the recipient's app might still be open and already
 * reachable over the relevant Socket.IO namespace.
 */
export const sendPushToDevice = async (
    deviceId: string,
    data: Record<string, string>
): Promise<boolean> => {
    try {
        const user = await User.findOne({ where: { deviceId } });
        if (!user?.fcmToken) return false;

        await admin.messaging().send({
            token: user.fcmToken,
            data,
            android: { priority: 'high' }
        });
        return true;
    } catch (error: any) {
        // invalid-registration-token / registration-token-not-registered
        // means the token is dead (uninstalled, reinstalled, token
        // rotated without us hearing about it yet) — clear it so future
        // calls don't keep paying the round-trip to find that out again.
        if (error?.code === 'messaging/invalid-registration-token' || error?.code === 'messaging/registration-token-not-registered') {
            await User.update({ fcmToken: null }, { where: { deviceId } });
        } else {
            logger.error(`❌ [PUSH] Failed to send to device ${deviceId}: ${error.message}`);
        }
        return false;
    }
};
