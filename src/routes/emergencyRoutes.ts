import { Router, Request, Response } from 'express';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { sendSocialAction, reconcileUserPlatforms } from '../services/socialService';
import { sendEmergencyAlertEmail } from '../utils/mailer';
import logger from '../utils/logger';

const router = Router();

/**
 * 🆘 SOS / Distress Alert
 *
 * Two independent notification channels, both best-effort (a failure in one
 * never blocks the other):
 *  1. Emails every saved emergency contact with type "email".
 *  2. Optionally broadcasts a status post to every CONNECTED social platform
 *     (`broadcastToSocials: true`) — this is opt-in and defaults to false on
 *     purpose: the automatic audio-spike-detection trigger (VoiceService)
 *     should NOT silently post a public SOS to someone's real social media on
 *     a false positive. Only the manual SOS button in the app sets this flag,
 *     and only after the user explicitly confirms.
 */
router.post('/alert', async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, latitude, longitude, distressSignature, broadcastToSocials } = req.body;
        if (!deviceId || latitude === undefined || longitude === undefined) {
            return res.status(200).json({ success: false, error: 'deviceId, latitude and longitude are required' });
        }

        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) {
            return res.status(200).json({ success: false, error: 'User resolve failed' });
        }

        const signature = distressSignature || 'Manual SOS triggered';
        const senderName = user.userName || 'a Mistreal user';

        // --- Channel 1: email emergency contacts ---
        const contacts: any[] = user.emergencyContacts || [];
        const emailContacts = contacts.filter((c: any) => c.type === 'email' && c.value);
        const emailResults = await Promise.allSettled(
            emailContacts.map((c: any) =>
                sendEmergencyAlertEmail(c.value, c.name || 'Emergency Contact', senderName, signature, latitude, longitude)
            )
        );
        const emailsSent = emailResults.filter(r => r.status === 'fulfilled' && r.value === true).length;

        // --- Channel 2: broadcast to connected social platforms (opt-in) ---
        let broadcastPlatforms: string[] = [];
        let broadcastFailures: string[] = [];
        if (broadcastToSocials === true) {
            const connected = await reconcileUserPlatforms(user);
            const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
            const message = `🆘 SOS Alert from ${senderName}. ${signature}. Last known location: ${mapsLink} — sent via Mistreal.`;

            const results = await Promise.allSettled(
                connected.map((platform: string) =>
                    sendSocialAction(user, { platform, type: 'Post', content: message }).then(() => platform)
                )
            );
            results.forEach((r, i) => {
                if (r.status === 'fulfilled') broadcastPlatforms.push(connected[i]);
                else {
                    broadcastFailures.push(connected[i]);
                    logger.warn(`⚠️ SOS broadcast failed on ${connected[i]}: ${(r.reason as any)?.message}`);
                }
            });
        }

        logger.info(`🆘 SOS alert for device ${deviceId}: ${emailsSent}/${emailContacts.length} emails sent, broadcast to [${broadcastPlatforms.join(', ')}]`);

        res.json({
            success: true,
            emailsSent,
            emailContactsTotal: emailContacts.length,
            broadcastPlatforms,
            broadcastFailures
        });
    } catch (e: any) {
        logger.error(`❌ POST /emergency/alert error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
