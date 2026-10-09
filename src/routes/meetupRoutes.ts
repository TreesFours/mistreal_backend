import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Op } from 'sequelize';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { sendSocialAction } from '../services/socialService';
import { MeetupProposal } from '../models/MeetupProposal';
import { MeetupConfirmation } from '../models/MeetupConfirmation';
import { EmergencyContact } from '../models/EmergencyContact';
import { EmergencyAlert } from '../models/EmergencyAlert';
import { persistToStorage } from './adRoutes';
import logger from '../utils/logger';

const router = Router();
const appUrl = () => process.env.APP_URL || 'https://mistreal-backend.onrender.com';
const SILENT_MEETUP_WINDOW_MS = 10 * 24 * 60 * 60 * 1000; // 10 days
const ESCALATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // matches Guardian's own window

// Device-bound: only whoever actually created the proposal from that exact
// device could ever have produced this token — proves "this specific
// device was issued this specific transaction," not just "someone typed a
// number." Reuses BYOK_ENCRYPTION_KEY as HMAC key material, same reasoning
// as emergencyRoutes.ts's signResponseToken.
const makeTransactionToken = (meetupSeed: string, deviceId: string): string => {
    const key = process.env.BYOK_ENCRYPTION_KEY || 'INSECURE_FALLBACK_SET_BYOK_ENCRYPTION_KEY';
    return crypto.createHmac('sha256', key).update(`${meetupSeed}:${deviceId}`).digest('hex').slice(0, 24);
};

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const renderMeetupPage = ({ title, body }: { title: string; body: string }): string => `
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} — Mistreal</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; margin: 0; padding: 32px 16px; }
        .card { background: #1e293b; padding: 32px; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); max-width: 480px; width: 100%; }
        h1 { color: #6366f1; font-size: 22px; margin: 0 0 16px; }
        p { color: #cbd5e1; line-height: 1.5; }
        .btn { display: inline-block; padding: 12px 22px; border-radius: 8px; font-weight: bold; font-size: 15px; border: none; cursor: pointer; margin: 4px 8px 0 0; }
        .btn-accept { background: #16a34a; color: #fff; }
        .btn-decline { background: #334155; color: #fff; }
        .brand { color: #64748b; font-size: 12px; margin-top: 24px; }
        a.map-link { color: #60a5fa; }
    </style>
</head>
<body>
    <div class="card">
        <h1>🤝 ${escapeHtml(title)}</h1>
        ${body}
        <p class="brand">Sent by Mistreal.</p>
    </div>
</body>
</html>`;

/**
 * Propose a meetup from within a chat. The proposer's own device shows this
 * as a local, self-rendered chat bubble immediately (client-side); the
 * counterparty — who may not have Mistreal at all — is reached the same
 * way the Guardian confirm flow reaches a contact: a real message
 * (platform DM via Zernio) carrying a no-login link to respond.
 */
router.post('/', async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, businessId, counterpartyPlatform, counterpartyContactId, latitude, longitude, addressLabel, scheduledAt } = req.body;
        if (!deviceId || latitude === undefined || longitude === undefined || !scheduledAt) {
            return res.status(200).json({ success: false, error: 'deviceId, latitude, longitude and scheduledAt are required' });
        }

        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });

        // Generated from a fresh random seed rather than the DB-assigned id —
        // avoids a create-then-update race where two concurrent proposals
        // could momentarily collide on the same placeholder token value.
        const transactionToken = makeTransactionToken(crypto.randomUUID(), deviceId);
        const meetup = await MeetupProposal.create({
            businessId: businessId || null,
            proposerDeviceId: deviceId,
            counterpartyPlatform: counterpartyPlatform || null,
            counterpartyContactId: counterpartyContactId || null,
            latitude, longitude,
            addressLabel: addressLabel || null,
            scheduledAt,
            status: 'proposed',
            transactionToken
        });

        if (counterpartyPlatform && counterpartyContactId) {
            const respondUrl = `${appUrl()}/api/meetups/${meetup.id}/respond`;
            const senderName = user.userName || 'A Mistreal user';
            const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
            sendSocialAction(user, {
                platform: counterpartyPlatform,
                type: 'Direct Message',
                content: `${senderName} proposed meeting at ${addressLabel || mapsLink} on ${new Date(scheduledAt).toLocaleString()}. Review & respond: ${respondUrl}`,
                targetId: counterpartyContactId
            }).catch((e: any) => logger.warn(`⚠️ Meetup proposal DM failed: ${e.message}`));
        }

        res.json({ success: true, meetup });
    } catch (e: any) {
        logger.error(`❌ POST /meetups error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, meetups: [], error: 'deviceId required' });
        const meetups = await MeetupProposal.findAll({ where: { proposerDeviceId: deviceId }, order: [['createdAt', 'DESC']] });
        res.json({ success: true, meetups });
    } catch (e: any) {
        res.status(200).json({ success: false, meetups: [], error: e.message });
    }
});

router.get('/by-token/:token', async (req: Request, res: Response) => {
    try {
        const meetup = await MeetupProposal.findOne({ where: { transactionToken: req.params.token } });
        if (!meetup) return res.status(200).json({ success: false, error: 'No transaction found for that token' });
        const confirmations = await MeetupConfirmation.findAll({ where: { meetupId: meetup.id } });
        res.json({ success: true, meetup, confirmations });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

// ============== Public no-login respond page (counterparty) ==============

router.get('/:id/respond', async (req: Request, res: Response) => {
    try {
        const meetup = await MeetupProposal.findByPk(req.params.id);
        if (!meetup) return res.status(404).send(renderMeetupPage({ title: 'Not found', body: '<p>This meetup request could not be found.</p>' }));

        if (meetup.status !== 'proposed') {
            return res.send(renderMeetupPage({
                title: `Already ${meetup.status}`,
                body: `<p>This meetup was already marked as ${escapeHtml(meetup.status)}.</p>`
            }));
        }

        const mapsLink = `https://www.google.com/maps?q=${meetup.latitude},${meetup.longitude}`;
        res.send(renderMeetupPage({
            title: 'Meetup Proposal',
            body: `
                <p>Proposed meeting at <strong>${escapeHtml(meetup.addressLabel || 'the shared location')}</strong> on <strong>${new Date(meetup.scheduledAt).toLocaleString()}</strong>.</p>
                <p>Location: <a class="map-link" href="${mapsLink}" target="_blank">${mapsLink}</a></p>
                <form method="POST" action="/api/meetups/${req.params.id}/respond" style="display:inline">
                    <input type="hidden" name="action" value="accept" />
                    <button type="submit" class="btn btn-accept">Accept</button>
                </form>
                <form method="POST" action="/api/meetups/${req.params.id}/respond" style="display:inline">
                    <input type="hidden" name="action" value="decline" />
                    <button type="submit" class="btn btn-decline">Decline</button>
                </form>
            `
        }));
    } catch (e: any) {
        logger.error(`❌ GET /meetups/:id/respond error: ${e.message}`);
        res.status(500).send('Something went wrong.');
    }
});

router.post('/:id/respond', async (req: Request, res: Response) => {
    try {
        const meetup = await MeetupProposal.findByPk(req.params.id);
        if (!meetup) return res.status(404).send(renderMeetupPage({ title: 'Not found', body: '<p>This meetup request could not be found.</p>' }));
        if (meetup.status === 'proposed') {
            meetup.status = req.body.action === 'accept' ? 'accepted' : 'declined';
            await meetup.save();
        }
        res.send(renderMeetupPage({
            title: meetup.status === 'accepted' ? 'Accepted' : 'Declined',
            body: meetup.status === 'accepted'
                ? '<p>Thanks — both sides can now confirm in person when you meet.</p>'
                : '<p>No problem — this meetup has been declined.</p>'
        }));
    } catch (e: any) {
        logger.error(`❌ POST /meetups/:id/respond error: ${e.message}`);
        res.status(500).send('Something went wrong.');
    }
});

/**
 * Confirm presence at the meeting — one row per device, photo proof
 * uploaded (not left orphaned locally, same fix as Guardian's SOS audio).
 */
router.post('/:id/confirm', async (req: Request, res: Response) => {
    try {
        const { deviceId, latitude, longitude, outcome, reasonIfFailed, reviewText, photoBase64, photoMimeType } = req.body;
        if (!deviceId || latitude === undefined || longitude === undefined || !outcome) {
            return res.status(200).json({ success: false, error: 'deviceId, latitude, longitude and outcome are required' });
        }
        const meetup = await MeetupProposal.findByPk(req.params.id);
        if (!meetup) return res.status(200).json({ success: false, error: 'Meetup not found' });

        let photoUrl: string | null = null;
        if (photoBase64) {
            try {
                const buffer = Buffer.from(photoBase64, 'base64');
                photoUrl = await persistToStorage(buffer, photoMimeType || 'image/jpeg', `meetup_proof/${meetup.id}/${deviceId}_${Date.now()}.jpg`);
            } catch (e: any) {
                logger.warn(`⚠️ Meetup confirmation photo upload failed (confirmation still recorded): ${e.message}`);
            }
        }

        const [confirmation] = await MeetupConfirmation.findOrCreate({
            where: { meetupId: meetup.id, deviceId },
            defaults: { meetupId: meetup.id, deviceId, latitude, longitude, photoUrl, outcome, reasonIfFailed: reasonIfFailed || null, reviewText: reviewText || null }
        });

        if (meetup.status === 'accepted') {
            meetup.status = 'completed';
            await meetup.save();
        }

        res.json({ success: true, confirmation });
    } catch (e: any) {
        logger.error(`❌ POST /meetups/:id/confirm error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;

/**
 * 10-day silent-meetup sweep: a meetup whose scheduledAt has passed with
 * zero MeetupConfirmation rows gets escalated into a real Guardian alert
 * (reusing the exact same confirmed-contact-notification + 30-day public
 * escalation pipeline already built) rather than inventing a second,
 * parallel notification system. Exported as a function, called from
 * index.ts's interval alongside the other background workers.
 */
export const sweepSilentMeetups = async () => {
    const overdue = await MeetupProposal.findAll({
        where: {
            status: { [Op.in]: ['proposed', 'accepted'] },
            scheduledAt: { [Op.lte]: new Date(Date.now() - SILENT_MEETUP_WINDOW_MS) }
        }
    });
    for (const meetup of overdue) {
        const confirmations = await MeetupConfirmation.count({ where: { meetupId: meetup.id } });
        if (confirmations > 0) continue;

        const alreadyAlerted = await EmergencyAlert.findOne({
            where: { ownerDeviceId: meetup.proposerDeviceId, triggerType: 'meetup_panic', distressSignature: { [Op.like]: `%meetup #${meetup.id}%` } }
        });
        if (alreadyAlerted) continue;

        const hasConfirmedContact = await EmergencyContact.count({ where: { ownerDeviceId: meetup.proposerDeviceId, status: 'confirmed' } });
        if (hasConfirmedContact === 0) continue; // nothing to notify — don't create a dead-end alert

        await EmergencyAlert.create({
            ownerDeviceId: meetup.proposerDeviceId,
            triggerType: 'meetup_panic',
            latitude: meetup.latitude,
            longitude: meetup.longitude,
            distressSignature: `Scheduled meetup #${meetup.id} was never confirmed by either side 10 days after the planned time.`,
            status: 'active',
            escalateAt: new Date(Date.now() + ESCALATION_WINDOW_MS)
        });
        logger.info(`🆘 Meetup ${meetup.id} unconfirmed 10 days past scheduled time — raised a Guardian alert for device ${meetup.proposerDeviceId}`);
    }
};
