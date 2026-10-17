import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Op } from 'sequelize';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { sendSocialAction } from '../services/socialService';
import { sendEmergencyContactInviteEmail, sendEmergencyAlertNotificationEmail, sendSosArchiveEmail } from '../utils/mailer';
import { sendSms } from '../utils/smsSender';
import { hasAddon } from '../services/addonService';
import { persistToStorage } from './adRoutes';
import { EmergencyContact } from '../models/EmergencyContact';
import { EmergencyAlert } from '../models/EmergencyAlert';
import { EmergencyAlertResponse } from '../models/EmergencyAlertResponse';
import { User } from '../models/userModel';
import logger from '../utils/logger';

const router = Router();

const appUrl = () => process.env.APP_URL || 'https://mistreal-backend.onrender.com';
// Legacy — still written to EmergencyAlert rows, no longer read by anything
// (the old 30-day own-platform escalation sweep that read it was removed;
// see index.ts history). Left in place rather than ripped out since
// removing the column/writes touches every caller for no behavioral gain.
const ESCALATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Dead-man's-switch escalation tiers for a fired alert — a nearby Mistreal
// user becomes able to see it (minimal detail) once past
// resolveSosTiming(owner).communityBroadcastDelayDays, upgrading to exact
// last-known location once past .fullDetailWindowDays, for as long as it
// stays unresolved. Both computed once at creation (GET /nearby-sos is a
// live read-time check against them, not a sweep that "fires" anything) —
// see EmergencyAlert.ts's model comment. Per-user, not a flat global — the
// three constants below are only the fallback defaults for a user who
// hasn't customized their own SOS preferences yet (PATCH /sos-preferences).
const DEFAULT_SILENT_MEETUP_WINDOW_DAYS = 4;
const DEFAULT_COMMUNITY_BROADCAST_DELAY_DAYS = 14;
const DEFAULT_FULL_DETAIL_WINDOW_DAYS = 30;
// Bounds exist so a user can't accidentally (or deliberately) configure
// their own dead-man's-switch to effectively never fire, or fire
// immediately and spam their contacts.
const clampDays = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(value)));

export interface SosTiming {
    silentMeetupWindowDays: number;
    communityBroadcastDelayDays: number;
    fullDetailWindowDays: number;
}

/** Per-user escalation timing, clamped to sane bounds, falling back to the house defaults for anything the user hasn't customized. */
export const resolveSosTiming = (user: User): SosTiming => {
    const saved = user.preferences?.sosDataCollection || {};
    return {
        silentMeetupWindowDays: clampDays(saved.silentMeetupWindowDays ?? DEFAULT_SILENT_MEETUP_WINDOW_DAYS, 1, 30),
        communityBroadcastDelayDays: clampDays(saved.communityBroadcastDelayDays ?? DEFAULT_COMMUNITY_BROADCAST_DELAY_DAYS, 1, 90),
        fullDetailWindowDays: clampDays(saved.fullDetailWindowDays ?? DEFAULT_FULL_DETAIL_WINDOW_DAYS, 1, 180)
    };
};
const COMMUNITY_BROADCAST_RADIUS_MILES = parseFloat(process.env.COMMUNITY_BROADCAST_RADIUS_MILES || '60');
// Anti-coercion: resolving only counts within this fixed radius of the
// owner's own pre-configured safe zone — not a per-user setting.
const SAFE_ZONE_RESOLVE_RADIUS_MILES = parseFloat(process.env.SAFE_ZONE_RESOLVE_RADIUS_MILES || '1');

const distanceMiles = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 3958.8; // Earth radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Signs a (alertId, contactId) pair rather than storing a separate token
// column — nothing needs to be generated/persisted ahead of time, and the
// link is only ever valid for that exact alert+contact pair. Reuses
// BYOK_ENCRYPTION_KEY as HMAC key material (it's already a required, real
// secret) rather than adding a new env var just for this.
const signResponseToken = (alertId: number, contactId: number): string => {
    const key = process.env.BYOK_ENCRYPTION_KEY || 'INSECURE_FALLBACK_SET_BYOK_ENCRYPTION_KEY';
    return crypto.createHmac('sha256', key).update(`${alertId}:${contactId}`).digest('hex');
};

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Shared shell for every public (no-login) page this file serves — the
// contact-invite confirm page, the alert-response page, and their
// post-action result pages. Deliberately presentable ("a great advert
// page") since for a contact with no app installed, this IS the app.
const renderEmergencyPage = ({ title, body }: { title: string; body: string }): string => `
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} — Mistreal</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; margin: 0; padding: 32px 16px; }
        .card { background: #1e293b; padding: 32px; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); max-width: 480px; width: 100%; }
        h1 { color: #ef4444; font-size: 22px; margin: 0 0 16px; }
        p { color: #cbd5e1; line-height: 1.5; }
        .btn { display: inline-block; padding: 12px 22px; border-radius: 8px; font-weight: bold; font-size: 15px; border: none; cursor: pointer; margin: 4px 8px 0 0; }
        .btn-confirm { background: #16a34a; color: #fff; }
        .btn-decline { background: #334155; color: #fff; }
        .btn-safe { background: #16a34a; color: #fff; }
        .btn-concern { background: #ef4444; color: #fff; }
        audio { width: 100%; margin-top: 12px; }
        .brand { color: #64748b; font-size: 12px; margin-top: 24px; }
        a.map-link { color: #60a5fa; }
    </style>
</head>
<body>
    <div class="card">
        <h1>🛡️ ${escapeHtml(title)}</h1>
        ${body}
        <p class="brand">Sent by Mistreal — your personal AI &amp; safety companion.</p>
    </div>
</body>
</html>`;

// ============== Emergency contacts ==============

router.get('/contacts', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, contacts: [], error: 'deviceId required' });
        const contacts = await EmergencyContact.findAll({ where: { ownerDeviceId: deviceId }, order: [['invitedAt', 'DESC']] });
        res.json({ success: true, contacts });
    } catch (e: any) {
        res.status(200).json({ success: false, contacts: [], error: e.message });
    }
});

router.post('/contacts', async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, name, channel, platform, platformContactId, email, phoneNumber } = req.body;
        if (!deviceId || !name || !channel) {
            return res.status(200).json({ success: false, error: 'deviceId, name and channel are required' });
        }
        if (channel === 'platform' && (!platform || !platformContactId)) {
            return res.status(200).json({ success: false, error: 'platform and platformContactId are required for a platform contact' });
        }
        if (channel === 'email' && !email) {
            return res.status(200).json({ success: false, error: 'email is required for an email contact' });
        }
        if (channel === 'sms') {
            if (!phoneNumber) return res.status(200).json({ success: false, error: 'phoneNumber is required for an SMS contact' });
            if (!(await hasAddon(deviceId, 'sms_notifications'))) {
                return res.status(200).json({ success: false, error: 'SMS Notifications add-on is not active on your account.' });
            }
        }

        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });

        const confirmToken = crypto.randomBytes(24).toString('hex');
        const contact = await EmergencyContact.create({
            ownerDeviceId: deviceId,
            name,
            channel,
            platform: channel === 'platform' ? platform : null,
            platformContactId: channel === 'platform' ? platformContactId : null,
            email: channel === 'email' ? email : null,
            phoneNumber: channel === 'sms' ? phoneNumber : null,
            status: 'pending',
            confirmToken
        });

        const confirmUrl = `${appUrl()}/api/emergency/confirm/${confirmToken}`;
        const ownerName = user.userName || 'A Mistreal user';
        const inviteMessage = `${ownerName} added you as their emergency contact on Mistreal. Confirm or decline: ${confirmUrl}`;

        // Best-effort — the contact row is already saved either way; the
        // owner can see it's still "pending" and re-send/remove it later if
        // the invite genuinely never got through.
        if (channel === 'email') {
            sendEmergencyContactInviteEmail(email, name, ownerName, confirmUrl)
                .catch((e: any) => logger.warn(`⚠️ Emergency contact invite email failed: ${e.message}`));
        } else if (channel === 'sms') {
            sendSms(phoneNumber, inviteMessage)
                .catch((e: any) => logger.warn(`⚠️ Emergency contact invite SMS failed: ${e.message}`));
        } else {
            sendSocialAction(user, {
                platform,
                type: 'Direct Message',
                content: inviteMessage,
                targetId: platformContactId
            }).catch((e: any) => logger.warn(`⚠️ Emergency contact invite DM failed: ${e.message}`));
        }

        res.json({ success: true, contact });
    } catch (e: any) {
        logger.error(`❌ POST /emergency/contacts error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.delete('/contacts/:id', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, error: 'deviceId required' });
        await EmergencyContact.destroy({ where: { id: req.params.id, ownerDeviceId: deviceId } });
        res.json({ success: true });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

// ============== Public contact confirm/decline (no login, no install) ==============

router.get('/confirm/:token', async (req: Request, res: Response) => {
    try {
        const contact = await EmergencyContact.findOne({ where: { confirmToken: req.params.token } });
        if (!contact) {
            return res.status(404).send(renderEmergencyPage({ title: 'Link not found', body: '<p>This link is invalid or has expired.</p>' }));
        }

        if (contact.status !== 'pending') {
            return res.send(renderEmergencyPage({
                title: contact.status === 'confirmed' ? 'Already confirmed' : 'Already declined',
                body: `<p>You already ${contact.status === 'confirmed' ? 'confirmed' : 'declined'} this request.</p>`
            }));
        }

        res.send(renderEmergencyPage({
            title: 'Emergency Contact Request',
            body: `
                <p><strong>${escapeHtml(contact.name)}</strong> has added you as their emergency contact on Mistreal.</p>
                <p>If they ever trigger a safety alert, you'll be notified with their last known location and a way to check on them — but only if you confirm below.</p>
                <form method="POST" action="/api/emergency/confirm/${req.params.token}" style="display:inline">
                    <input type="hidden" name="action" value="confirm" />
                    <button type="submit" class="btn btn-confirm">Confirm — I'll be their emergency contact</button>
                </form>
                <form method="POST" action="/api/emergency/confirm/${req.params.token}" style="display:inline">
                    <input type="hidden" name="action" value="decline" />
                    <button type="submit" class="btn btn-decline">Decline</button>
                </form>
            `
        }));
    } catch (e: any) {
        logger.error(`❌ GET /emergency/confirm error: ${e.message}`);
        res.status(500).send('Something went wrong.');
    }
});

router.post('/confirm/:token', async (req: Request, res: Response) => {
    try {
        const contact = await EmergencyContact.findOne({ where: { confirmToken: req.params.token } });
        if (!contact) {
            return res.status(404).send(renderEmergencyPage({ title: 'Link not found', body: '<p>This link is invalid or has expired.</p>' }));
        }
        if (contact.status === 'pending') {
            const action = req.body.action === 'confirm' ? 'confirmed' : 'declined';
            contact.status = action;
            if (action === 'confirmed') contact.confirmedAt = new Date();
            await contact.save();
        }
        res.send(renderEmergencyPage({
            title: contact.status === 'confirmed' ? "You're confirmed" : 'Declined',
            body: contact.status === 'confirmed'
                ? "<p>Thanks — you're now set as their emergency contact. You'll only hear from us if they ever trigger a real alert.</p>"
                : "<p>No problem — you've been removed from their emergency contact list.</p>"
        }));
    } catch (e: any) {
        logger.error(`❌ POST /emergency/confirm error: ${e.message}`);
        res.status(500).send('Something went wrong.');
    }
});

// ============== Alerts ==============

router.get('/alerts', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, alerts: [], error: 'deviceId required' });
        const alerts = await EmergencyAlert.findAll({ where: { ownerDeviceId: deviceId }, order: [['createdAt', 'DESC']] });
        res.json({ success: true, alerts });
    } catch (e: any) {
        res.status(200).json({ success: false, alerts: [], error: e.message });
    }
});

/**
 * Notifies this alert's confirmed emergency contacts and fires the fixed-
 * destination archival email (mailer.ts's sendSosArchiveEmail) — shared by
 * both the manual `POST /alerts` route below and the meetup dead-man's-
 * switch sweep (meetupRoutes.ts's sweepSilentMeetups), which previously
 * never notified anyone at all. [counterpartyName] is only ever non-null
 * for a meetup_panic alert.
 */
export const notifyConfirmedContacts = async (
    alert: EmergencyAlert,
    user: User,
    signature: string,
    counterpartyName: string | null = null
): Promise<{ notified: number; total: number }> => {
    const confirmedContacts = await EmergencyContact.findAll({ where: { ownerDeviceId: alert.ownerDeviceId, status: 'confirmed' } });
    const senderName = user.userName || 'a Mistreal user';
    // Re-checked at send time, not just at invite time — the owner could
    // have canceled the add-on since adding this contact.
    const smsEnabled = await hasAddon(alert.ownerDeviceId, 'sms_notifications');

    const notifyResults = await Promise.allSettled(confirmedContacts.map(async (contact) => {
        const token = signResponseToken(alert.id, contact.id);
        const respondUrl = `${appUrl()}/api/emergency/alerts/${alert.id}/respond/${contact.id}/${token}`;
        if (contact.channel === 'email' && contact.email) {
            return sendEmergencyAlertNotificationEmail(contact.email, contact.name, senderName, signature, respondUrl);
        }
        if (contact.channel === 'sms' && contact.phoneNumber) {
            if (!smsEnabled) {
                logger.warn(`⚠️ Skipped SMS to confirmed contact ${contact.id}: sms_notifications add-on no longer active for device ${alert.ownerDeviceId}`);
                return;
            }
            return sendSms(contact.phoneNumber, `🆘 SOS Alert from ${senderName}. ${signature}. View location & respond: ${respondUrl}`);
        }
        if (contact.channel === 'platform' && contact.platform && contact.platformContactId) {
            return sendSocialAction(user, {
                platform: contact.platform,
                type: 'Direct Message',
                content: `🆘 SOS Alert from ${senderName}. ${signature}. View location & respond: ${respondUrl}`,
                targetId: contact.platformContactId
            });
        }
    }));
    const notified = notifyResults.filter(r => r.status === 'fulfilled').length;

    sendSosArchiveEmail(alert, senderName, alert.ownerDeviceId, counterpartyName)
        .catch((e: any) => logger.warn(`⚠️ SOS archive email failed (alert still notified): ${e.message}`));

    logger.info(`🆘 Alert ${alert.id} (device ${alert.ownerDeviceId}): notified ${notified}/${confirmedContacts.length} confirmed contacts`);
    return { notified, total: confirmedContacts.length };
};

/**
 * 🆘 Fire an alert. Accepts the SOS audio/photo as base64 (recordings are
 * short — capped client-side — so this stays well under any reasonable
 * JSON body-size limit; same reasoning as the base64 image path in
 * socialRoutes.ts) and persists it to Firebase Storage via the same helper
 * Ads uses, rather than leaving it orphaned in local app storage with
 * nothing referencing it afterward.
 *
 * Only notifies CONFIRMED contacts (hard requirement) — a pending/declined
 * contact never receives alert content, only ever the initial invite.
 */
router.post('/alerts', async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, latitude, longitude, distressSignature, triggerType, sosAudioBase64, sosAudioMimeType, sosImageBase64, sosImageMimeType } = req.body;
        if (!deviceId || latitude === undefined || longitude === undefined) {
            return res.status(200).json({ success: false, error: 'deviceId, latitude and longitude are required' });
        }

        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });

        let sosAudioUrl: string | null = null;
        if (sosAudioBase64) {
            try {
                const buffer = Buffer.from(sosAudioBase64, 'base64');
                sosAudioUrl = await persistToStorage(deviceId, buffer, sosAudioMimeType || 'audio/mp4', `sos_audio/${deviceId}/${Date.now()}.m4a`);
            } catch (e: any) {
                logger.warn(`⚠️ SOS audio upload failed (alert still created): ${e.message}`);
            }
        }
        let sosImageUrl: string | null = null;
        if (sosImageBase64) {
            try {
                const buffer = Buffer.from(sosImageBase64, 'base64');
                sosImageUrl = await persistToStorage(deviceId, buffer, sosImageMimeType || 'image/jpeg', `sos_image/${deviceId}/${Date.now()}.jpg`);
            } catch (e: any) {
                logger.warn(`⚠️ SOS image upload failed (alert still created): ${e.message}`);
            }
        }

        const signature = distressSignature || 'Manual SOS triggered';
        const now = Date.now();
        const timing = resolveSosTiming(user);
        const alert = await EmergencyAlert.create({
            ownerDeviceId: deviceId,
            triggerType: triggerType || 'manual',
            latitude, longitude,
            sosAudioUrl,
            sosImageUrl,
            distressSignature: signature,
            status: 'active',
            escalateAt: new Date(now + ESCALATION_WINDOW_MS),
            nextCommunityBroadcastAt: new Date(now + timing.communityBroadcastDelayDays * 86400000),
            fullDetailAt: new Date(now + timing.fullDetailWindowDays * 86400000)
        });

        const { notified, total } = await notifyConfirmedContacts(alert, user, signature);
        res.json({ success: true, alert, confirmedContactsNotified: notified, confirmedContactsTotal: total });
    } catch (e: any) {
        logger.error(`❌ POST /emergency/alerts error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

/**
 * Attaches SOS ambient audio to an alert that already fired without it —
 * the recording (up to 120s, capturing the situation as it unfolds) is
 * still running when the alert itself needs to go out immediately, so this
 * is a deliberate follow-up call rather than making alert creation wait on
 * a full recording first.
 */
router.patch('/alerts/:id/audio', async (req: Request, res: Response) => {
    try {
        const { deviceId, sosAudioBase64, sosAudioMimeType } = req.body;
        const alert = await EmergencyAlert.findOne({ where: { id: req.params.id, ownerDeviceId: deviceId } });
        if (!alert) return res.status(200).json({ success: false, error: 'Alert not found' });
        if (!sosAudioBase64) return res.status(200).json({ success: false, error: 'sosAudioBase64 is required' });

        const buffer = Buffer.from(sosAudioBase64, 'base64');
        alert.sosAudioUrl = await persistToStorage(deviceId, buffer, sosAudioMimeType || 'audio/mp4', `sos_audio/${deviceId}/${Date.now()}.m4a`);
        await alert.save();
        res.json({ success: true, alert });
    } catch (e: any) {
        logger.error(`❌ PATCH /emergency/alerts/:id/audio error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

/** Same shape as the audio attach above — a photo captured at SOS-press time, mirrors it exactly. */
router.patch('/alerts/:id/image', async (req: Request, res: Response) => {
    try {
        const { deviceId, sosImageBase64, sosImageMimeType } = req.body;
        const alert = await EmergencyAlert.findOne({ where: { id: req.params.id, ownerDeviceId: deviceId } });
        if (!alert) return res.status(200).json({ success: false, error: 'Alert not found' });
        if (!sosImageBase64) return res.status(200).json({ success: false, error: 'sosImageBase64 is required' });

        const buffer = Buffer.from(sosImageBase64, 'base64');
        alert.sosImageUrl = await persistToStorage(deviceId, buffer, sosImageMimeType || 'image/jpeg', `sos_image/${deviceId}/${Date.now()}.jpg`);
        await alert.save();
        res.json({ success: true, alert });
    } catch (e: any) {
        logger.error(`❌ PATCH /emergency/alerts/:id/image error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

/**
 * Owner marks themselves safe — cancels escalation immediately. Anti-
 * coercion requirement: only counts if the owner's CURRENT live location is
 * within SAFE_ZONE_RESOLVE_RADIUS_MILES of their own pre-configured safe
 * zone (PATCH /safe-zone) — someone forced to tap this while NOT actually
 * safe must not be able to satisfy it. Fails closed: no safe zone
 * configured at all means this can never succeed until one is set up
 * (acceptable since safe-zone setup is a required step before Guardian/SOS
 * features are usable in the first place, not an edge case that leaves a
 * user stuck).
 */
router.post('/alerts/:id/resolve', async (req: Request, res: Response) => {
    try {
        const { deviceId, latitude, longitude } = req.body;
        if (latitude === undefined || longitude === undefined) {
            return res.status(200).json({ success: false, error: 'A live location is required to resolve an alert.' });
        }
        const alert = await EmergencyAlert.findOne({ where: { id: req.params.id, ownerDeviceId: deviceId } });
        if (!alert) return res.status(200).json({ success: false, error: 'Alert not found' });

        const user = await User.findOne({ where: { deviceId } });
        const safeZone = user?.preferences?.safeZone;
        if (!safeZone) {
            return res.status(200).json({ success: false, error: 'No safe zone configured. Set one up in Settings before you can resolve an alert.' });
        }
        const dist = distanceMiles(latitude, longitude, safeZone.latitude, safeZone.longitude);
        if (dist > SAFE_ZONE_RESOLVE_RADIUS_MILES) {
            return res.status(200).json({ success: false, error: 'You must be within your configured safe zone to resolve an alert.' });
        }

        alert.status = 'resolved_safe';
        alert.resolvedAt = new Date();
        await alert.save();
        res.json({ success: true });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

// ============== Safe zone (required setup, anti-coercion anchor for resolve) ==============

router.get('/safe-zone', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, error: 'deviceId required' });
        const user = await User.findOne({ where: { deviceId } });
        res.json({ success: true, safeZone: user?.preferences?.safeZone || null });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

/**
 * Deliberately only ever stores whatever latitude/longitude the client
 * sends — the client contract is that this is ALWAYS the device's own live
 * GPS fix at save time (LocationHelper.getCurrentLocation()), never a
 * manually-typed coordinate, so a safe zone can't be configured remotely.
 * The server can't technically distinguish a live fix from a typed one;
 * the anti-coercion guarantee lives in the client never exposing a text
 * field for this value, not a server-side check.
 */
router.patch('/safe-zone', async (req: Request, res: Response) => {
    try {
        const { deviceId, latitude, longitude } = req.body;
        if (!deviceId || latitude === undefined || longitude === undefined) {
            return res.status(200).json({ success: false, error: 'deviceId, latitude and longitude are required' });
        }
        const user = await getOrCreateUserInternal(deviceId);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });
        user.set('preferences', { ...user.preferences, safeZone: { latitude, longitude } });
        user.changed('preferences', true);
        await user.save();
        res.json({ success: true, safeZone: user.preferences.safeZone });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

// ============== SOS data-collection preferences (what to capture/share in an emergency) ==============

router.get('/sos-preferences', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, error: 'deviceId required' });
        const user = await User.findOne({ where: { deviceId } });
        const defaults = {
            camera: true, microphone: true, image: true, fullDetailEscalation: true,
            silentMeetupWindowDays: DEFAULT_SILENT_MEETUP_WINDOW_DAYS,
            communityBroadcastDelayDays: DEFAULT_COMMUNITY_BROADCAST_DELAY_DAYS,
            fullDetailWindowDays: DEFAULT_FULL_DETAIL_WINDOW_DAYS
        };
        res.json({ success: true, preferences: { ...defaults, ...(user?.preferences?.sosDataCollection || {}) } });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

router.patch('/sos-preferences', async (req: Request, res: Response) => {
    try {
        const { deviceId, camera, microphone, image, fullDetailEscalation, silentMeetupWindowDays, communityBroadcastDelayDays, fullDetailWindowDays } = req.body;
        if (!deviceId) return res.status(200).json({ success: false, error: 'deviceId required' });
        const user = await getOrCreateUserInternal(deviceId);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });
        const existing = user.preferences?.sosDataCollection || {};
        const updated = {
            camera: camera !== undefined ? !!camera : existing.camera ?? true,
            microphone: microphone !== undefined ? !!microphone : existing.microphone ?? true,
            image: image !== undefined ? !!image : existing.image ?? true,
            fullDetailEscalation: fullDetailEscalation !== undefined ? !!fullDetailEscalation : existing.fullDetailEscalation ?? true,
            // Clamped server-side (1-30/1-90/1-180 days) so a user can't
            // configure their own dead-man's-switch to effectively never
            // fire, or fire immediately and spam their contacts.
            silentMeetupWindowDays: clampDays(
                silentMeetupWindowDays !== undefined ? Number(silentMeetupWindowDays) : existing.silentMeetupWindowDays ?? DEFAULT_SILENT_MEETUP_WINDOW_DAYS,
                1, 30
            ),
            communityBroadcastDelayDays: clampDays(
                communityBroadcastDelayDays !== undefined ? Number(communityBroadcastDelayDays) : existing.communityBroadcastDelayDays ?? DEFAULT_COMMUNITY_BROADCAST_DELAY_DAYS,
                1, 90
            ),
            fullDetailWindowDays: clampDays(
                fullDetailWindowDays !== undefined ? Number(fullDetailWindowDays) : existing.fullDetailWindowDays ?? DEFAULT_FULL_DETAIL_WINDOW_DAYS,
                1, 180
            )
        };
        user.set('preferences', { ...user.preferences, sosDataCollection: updated });
        user.changed('preferences', true);
        await user.save();
        res.json({ success: true, preferences: updated });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

// ============== Community broadcast (stateless, no push infra — matches GET /needs/matches' live-query convention) ==============

/**
 * Any Mistreal user within COMMUNITY_BROADCAST_RADIUS_MILES of an
 * unresolved alert's last-known location, once it's past
 * nextCommunityBroadcastAt. Deliberately omits ownerDeviceId and exact
 * lat/lon before fullDetailAt — a stranger gets "someone nearby is
 * unconfirmed-safe, ~N miles away", not an identifying pin, until the
 * alert has gone 30 days with zero response.
 */
router.get('/nearby-sos', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: true, alerts: [] });
        const requester = await User.findOne({ where: { deviceId } });
        if (!requester?.lastKnownLat || !requester?.lastKnownLon) {
            return res.status(200).json({ success: true, alerts: [] }); // no location on file — nothing to compare against, not an error
        }

        const candidates = await EmergencyAlert.findAll({
            where: { status: 'active', nextCommunityBroadcastAt: { [Op.lte]: new Date() } }
        });

        const nearby: any[] = [];
        for (const alert of candidates) {
            if (alert.ownerDeviceId === deviceId) continue; // never show your own alert back to yourself
            const responseCount = await EmergencyAlertResponse.count({ where: { alertId: alert.id } });
            if (responseCount > 0) continue; // a contact already responded — not broadcast-eligible

            const dist = distanceMiles(requester.lastKnownLat, requester.lastKnownLon, alert.latitude, alert.longitude);
            if (dist > COMMUNITY_BROADCAST_RADIUS_MILES) continue;

            const isFullDetail = !!alert.fullDetailAt && alert.fullDetailAt.getTime() <= Date.now();
            nearby.push({
                id: alert.id,
                createdAt: alert.createdAt,
                distanceMiles: Math.round(dist * 10) / 10,
                distressSignature: alert.distressSignature,
                sosAudioUrl: alert.sosAudioUrl,
                sosImageUrl: alert.sosImageUrl,
                fullDetail: isFullDetail,
                latitude: isFullDetail ? alert.latitude : null,
                longitude: isFullDetail ? alert.longitude : null
            });
        }
        res.json({ success: true, alerts: nearby });
    } catch (e: any) {
        res.status(200).json({ success: false, alerts: [], error: e.message });
    }
});

// ============== Public alert-response page (confirmed contact, no login) ==============

router.get('/alerts/:alertId/respond/:contactId/:token', async (req: Request, res: Response) => {
    try {
        const { alertId, contactId, token } = req.params;
        if (signResponseToken(Number(alertId), Number(contactId)) !== token) {
            return res.status(403).send(renderEmergencyPage({ title: 'Invalid link', body: '<p>This link is not valid.</p>' }));
        }
        const alert = await EmergencyAlert.findByPk(alertId);
        const contact = await EmergencyContact.findByPk(contactId);
        if (!alert || !contact || contact.status !== 'confirmed') {
            return res.status(404).send(renderEmergencyPage({ title: 'Not found', body: '<p>This alert could not be found.</p>' }));
        }

        const existing = await EmergencyAlertResponse.findOne({ where: { alertId: alert.id, contactId: contact.id } });
        const mapsLink = `https://www.google.com/maps?q=${alert.latitude},${alert.longitude}`;

        res.send(renderEmergencyPage({
            title: 'SOS Alert',
            body: `
                <p>${escapeHtml(alert.distressSignature || 'A safety alert was triggered.')}</p>
                <p>Last known location: <a class="map-link" href="${mapsLink}" target="_blank">${mapsLink}</a></p>
                ${alert.sosAudioUrl ? `<audio controls src="${alert.sosAudioUrl}"></audio>` : ''}
                ${existing
                    ? `<p><strong>You already responded: ${existing.response === 'confirmed_safe' ? "confirmed they're safe" : 'raised a concern'}.</strong></p>`
                    : `
                        <form method="POST" action="/api/emergency/alerts/${alertId}/respond/${contactId}/${token}" style="display:inline">
                            <input type="hidden" name="response" value="confirmed_safe" />
                            <button type="submit" class="btn btn-safe">They're safe</button>
                        </form>
                        <form method="POST" action="/api/emergency/alerts/${alertId}/respond/${contactId}/${token}" style="display:inline">
                            <input type="hidden" name="response" value="raised_concern" />
                            <button type="submit" class="btn btn-concern">I'm worried — raise concern</button>
                        </form>
                    `}
            `
        }));
    } catch (e: any) {
        logger.error(`❌ GET /emergency/alerts/respond error: ${e.message}`);
        res.status(500).send('Something went wrong.');
    }
});

router.post('/alerts/:alertId/respond/:contactId/:token', async (req: Request, res: Response) => {
    try {
        const { alertId, contactId, token } = req.params;
        if (signResponseToken(Number(alertId), Number(contactId)) !== token) {
            return res.status(403).send(renderEmergencyPage({ title: 'Invalid link', body: '<p>This link is not valid.</p>' }));
        }
        const response = req.body.response === 'raised_concern' ? 'raised_concern' : 'confirmed_safe';
        await EmergencyAlertResponse.findOrCreate({
            where: { alertId: Number(alertId), contactId: Number(contactId) },
            defaults: { alertId: Number(alertId), contactId: Number(contactId), response }
        });
        res.send(renderEmergencyPage({
            title: 'Thank you',
            body: response === 'confirmed_safe'
                ? '<p>Thanks for checking — noted as safe.</p>'
                : "<p>Thanks — your concern has been noted. This does not auto-contact authorities; please escalate yourself if you believe this is urgent.</p>"
        }));
    } catch (e: any) {
        logger.error(`❌ POST /emergency/alerts/respond error: ${e.message}`);
        res.status(500).send('Something went wrong.');
    }
});

export default router;
