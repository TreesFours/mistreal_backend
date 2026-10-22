import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Op } from 'sequelize';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { sendSocialAction } from '../services/socialService';
import { MeetupProposal } from '../models/MeetupProposal';
import { MeetupConfirmation } from '../models/MeetupConfirmation';
import { Business } from '../models/businessModel';
import { ComfortMeetConfirmation } from '../models/ComfortMeetConfirmation';
import { EmergencyContact } from '../models/EmergencyContact';
import { EmergencyAlert } from '../models/EmergencyAlert';
import { User } from '../models/userModel';
import { notifyConfirmedContacts, resolveSosTiming } from './emergencyRoutes';
import { persistToStorage } from './adRoutes';
import logger from '../utils/logger';

const router = Router();
const appUrl = () => process.env.APP_URL || 'https://mistreal-backend.onrender.com';
const ESCALATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // legacy, see emergencyRoutes.ts's model comment

// How close ('comfort' meetups only) two devices' live pings need to be,
// and how fresh each side's most recent ping needs to be relative to the
// other, before the backend confirms the meet jointly — see comfort-ping
// below. Both tunable without a redeploy.
const COMFORT_MEET_PROXIMITY_METERS = parseFloat(process.env.COMFORT_MEET_PROXIMITY_METERS || '150');
const COMFORT_MEET_PING_WINDOW_MS = parseFloat(process.env.COMFORT_MEET_PING_WINDOW_MS || '90000');

// In-memory only — a dropped/restarted server just means both sides' next
// ping re-establishes freshness within seconds; nothing worth persisting
// about a ping that never turned into a confirmation.
const lastPingByMeetupDevice = new Map<string, { latitude: number; longitude: number; atMs: number }>();

const distanceMeters = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

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
        const {
            deviceId, firebaseUid, businessId, counterpartyPlatform, counterpartyContactId, counterpartyDeviceId,
            meetupType, latitude, longitude, addressLabel, scheduledAt
        } = req.body;
        if (!deviceId || latitude === undefined || longitude === undefined || !scheduledAt) {
            return res.status(200).json({ success: false, error: 'deviceId, latitude, longitude and scheduledAt are required' });
        }
        // Comfort meets are cross-checked by live location against a
        // specific other device, not DMed to a platform contact who may
        // not have the app at all — needs to actually know who that is.
        if (meetupType === 'comfort' && !counterpartyDeviceId) {
            return res.status(200).json({ success: false, error: 'counterpartyDeviceId is required for a comfort meet' });
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
            counterpartyDeviceId: counterpartyDeviceId || null,
            meetupType: meetupType === 'comfort' ? 'comfort' : 'business',
            latitude, longitude,
            addressLabel: addressLabel || null,
            scheduledAt,
            status: 'proposed',
            transactionToken
        });

        if (counterpartyPlatform && counterpartyContactId) {
            // Keyed by the unguessable transactionToken, not the sequential
            // DB id — this is a no-login link a non-app counterparty can
            // act on, so the token itself has to be the only "auth" there
            // is, otherwise anyone could enumerate ids to view the meeting
            // location or accept/decline someone else's meetup.
            const respondUrl = `${appUrl()}/api/meetups/${meetup.transactionToken}/respond`;
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

router.get('/:token/respond', async (req: Request, res: Response) => {
    try {
        const meetup = await MeetupProposal.findOne({ where: { transactionToken: req.params.token } });
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
                <form method="POST" action="/api/meetups/${req.params.token}/respond" style="display:inline">
                    <input type="hidden" name="action" value="accept" />
                    <button type="submit" class="btn btn-accept">Accept</button>
                </form>
                <form method="POST" action="/api/meetups/${req.params.token}/respond" style="display:inline">
                    <input type="hidden" name="action" value="decline" />
                    <button type="submit" class="btn btn-decline">Decline</button>
                </form>
            `
        }));
    } catch (e: any) {
        logger.error(`❌ GET /meetups/:token/respond error: ${e.message}`);
        res.status(500).send('Something went wrong.');
    }
});

router.post('/:token/respond', async (req: Request, res: Response) => {
    try {
        const meetup = await MeetupProposal.findOne({ where: { transactionToken: req.params.token } });
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
        logger.error(`❌ POST /meetups/:token/respond error: ${e.message}`);
        res.status(500).send('Something went wrong.');
    }
});

/**
 * Confirm presence at the meeting — one row per device, photo proof
 * uploaded (not left orphaned locally, same fix as Guardian's SOS audio).
 */
router.post('/:id/confirm', async (req: Request, res: Response) => {
    try {
        const { deviceId, latitude, longitude, outcome, reasonIfFailed, reviewText, buyerVote, photoBase64, photoMimeType } = req.body;
        if (!deviceId || latitude === undefined || longitude === undefined || !outcome) {
            return res.status(200).json({ success: false, error: 'deviceId, latitude, longitude and outcome are required' });
        }
        const meetup = await MeetupProposal.findByPk(req.params.id);
        if (!meetup) return res.status(200).json({ success: false, error: 'Meetup not found' });

        // Same "this device is actually part of this meetup" guard
        // comfort-ping already enforces — without it, anyone who knows (or
        // guesses, since ids are sequential) a meetup id and the real
        // buyer's/business's deviceId could file a fabricated confirmation
        // in their place, which also permanently blocks that real
        // participant from ever confirming (unique on meetupId+deviceId).
        const isDirectParticipant = deviceId === meetup.proposerDeviceId || deviceId === meetup.counterpartyDeviceId;
        const isBusinessOwner = meetup.businessId
            ? !!(await Business.findOne({ where: { businessId: meetup.businessId, ownerDeviceId: deviceId } }))
            : false;
        if (!isDirectParticipant && !isBusinessOwner) {
            return res.status(200).json({ success: false, error: 'This device is not part of this meetup' });
        }

        let photoUrl: string | null = null;
        if (photoBase64) {
            try {
                const buffer = Buffer.from(photoBase64, 'base64');
                photoUrl = await persistToStorage(deviceId, buffer, photoMimeType || 'image/jpeg', `meetup_proof/${meetup.id}/${deviceId}_${Date.now()}.jpg`);
            } catch (e: any) {
                logger.warn(`⚠️ Meetup confirmation photo upload failed (confirmation still recorded): ${e.message}`);
            }
        }

        // A thumbs up/down only ever makes sense from the buyer's side of a
        // business transaction — the proposer, per the real flow (customer
        // discovers -> contacts -> proposes) — never on the business's own
        // confirmation of its own sale.
        const isBuyerSide = meetup.businessId && deviceId === meetup.proposerDeviceId;
        const validVote = isBuyerSide && outcome === 'success' && (buyerVote === 'up' || buyerVote === 'down') ? buyerVote : null;

        const [confirmation] = await MeetupConfirmation.findOrCreate({
            where: { meetupId: meetup.id, deviceId },
            defaults: { meetupId: meetup.id, deviceId, latitude, longitude, photoUrl, outcome, reasonIfFailed: reasonIfFailed || null, reviewText: reviewText || null, buyerVote: validVote }
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

/**
 * Live proximity check-in for a 'comfort' meetup — both sides call this
 * repeatedly (e.g. every few seconds) while their "I'm here" screen is
 * open. Each call records this device's current ping, then checks whether
 * the OTHER party (proposer or counterpartyDeviceId, whichever isn't the
 * caller) has a ping of its own fresh enough and close enough to confirm —
 * this is the actual cross-check the original business-meetup flow never
 * had (that one is pure self-report). Idempotent: once a
 * ComfortMeetConfirmation row exists, every subsequent ping from either
 * side just reports it back, it's never created twice (unique on meetupId).
 */
router.post('/:id/comfort-ping', async (req: Request, res: Response) => {
    try {
        const { deviceId, latitude, longitude } = req.body;
        if (!deviceId || latitude === undefined || longitude === undefined) {
            return res.status(200).json({ success: false, error: 'deviceId, latitude and longitude are required' });
        }
        const meetup = await MeetupProposal.findByPk(req.params.id);
        if (!meetup) return res.status(200).json({ success: false, error: 'Meetup not found' });
        if (meetup.meetupType !== 'comfort') {
            return res.status(200).json({ success: false, error: 'This meetup is not a comfort meet' });
        }
        const otherDeviceId = deviceId === meetup.proposerDeviceId ? meetup.counterpartyDeviceId : meetup.proposerDeviceId;
        if (deviceId !== meetup.proposerDeviceId && deviceId !== meetup.counterpartyDeviceId) {
            return res.status(200).json({ success: false, error: 'This device is not part of this meetup' });
        }

        const existing = await ComfortMeetConfirmation.findOne({ where: { meetupId: meetup.id } });
        if (existing) {
            return res.json({ success: true, confirmed: true, distanceMeters: existing.distanceMeters, confirmedAt: existing.confirmedAt });
        }

        const now = Date.now();
        lastPingByMeetupDevice.set(`${meetup.id}:${deviceId}`, { latitude, longitude, atMs: now });

        const otherPing = otherDeviceId ? lastPingByMeetupDevice.get(`${meetup.id}:${otherDeviceId}`) : undefined;
        if (!otherPing || now - otherPing.atMs > COMFORT_MEET_PING_WINDOW_MS) {
            return res.json({ success: true, confirmed: false });
        }

        const distance = distanceMeters(latitude, longitude, otherPing.latitude, otherPing.longitude);
        if (distance > COMFORT_MEET_PROXIMITY_METERS) {
            return res.json({ success: true, confirmed: false, distanceMeters: distance });
        }

        const confirmation = await ComfortMeetConfirmation.create({
            meetupId: meetup.id,
            deviceIdA: meetup.proposerDeviceId,
            deviceIdB: meetup.counterpartyDeviceId,
            distanceMeters: distance
        });
        meetup.status = 'completed';
        await meetup.save();
        lastPingByMeetupDevice.delete(`${meetup.id}:${deviceId}`);
        if (otherDeviceId) lastPingByMeetupDevice.delete(`${meetup.id}:${otherDeviceId}`);

        logger.info(`💞 Comfort meet confirmed: meetup #${meetup.id}, ${distance.toFixed(0)}m apart`);
        res.json({ success: true, confirmed: true, distanceMeters: distance, confirmedAt: confirmation.confirmedAt });
    } catch (e: any) {
        logger.error(`❌ POST /meetups/:id/comfort-ping error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

// Personal stat — shown as a distinct badge/count from a business's
// confirmed-meetups trust counter, never mixed with it.
router.get('/comfort-count', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, count: 0, error: 'deviceId required' });
        const count = await ComfortMeetConfirmation.count({
            where: { [Op.or]: [{ deviceIdA: deviceId }, { deviceIdB: deviceId }] }
        });
        res.json({ success: true, count });
    } catch (e: any) {
        res.status(200).json({ success: false, count: 0, error: e.message });
    }
});

export default router;

/**
 * Resolves who a silent meetup's counterparty actually was, for the
 * distress signature / archival email — falls back gracefully for a
 * business-type meetup whose counterparty has no app/device row at all.
 */
const resolveCounterpartyName = async (meetup: MeetupProposal): Promise<string> => {
    if (meetup.counterpartyDeviceId) {
        const counterpartyUser = await User.findOne({ where: { deviceId: meetup.counterpartyDeviceId } });
        if (counterpartyUser?.userName) return counterpartyUser.userName;
    }
    if (meetup.counterpartyPlatform) return `a contact on ${meetup.counterpartyPlatform}`;
    return 'an unconfirmed counterparty';
};

// Coarse DB-level floor (the minimum any user is allowed to configure their
// own silentMeetupWindowDays to, per resolveSosTiming's 1-30 day clamp) —
// the actual per-user threshold is checked precisely below, this just
// keeps the initial query from scanning meetups that can't possibly be due
// for ANY user yet.
const MIN_SILENT_MEETUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Silent-meetup sweep: a meetup whose scheduledAt has passed the
 * PROPOSER'S OWN configured silent-meetup window (default 4 days, user-
 * adjustable via PATCH /api/emergency/sos-preferences, see
 * emergencyRoutes.ts's resolveSosTiming) with zero confirmation raises a
 * real Guardian alert AND immediately notifies the proposer's confirmed
 * emergency contacts (see notifyConfirmedContacts in emergencyRoutes.ts) —
 * this used to create the alert row directly and notify nobody, a real
 * gap, not by design. Checks BOTH MeetupConfirmation (self-reported,
 * business-type) and ComfortMeetConfirmation (live-proximity cross-check,
 * comfort-type) — a comfort meetup that actually passed its proximity
 * check has zero MeetupConfirmation rows by design and was previously
 * misread as silent. Exported as a function, called from index.ts's
 * interval alongside the other background workers.
 */
export const sweepSilentMeetups = async () => {
    const candidates = await MeetupProposal.findAll({
        where: {
            status: { [Op.in]: ['proposed', 'accepted'] },
            scheduledAt: { [Op.lte]: new Date(Date.now() - MIN_SILENT_MEETUP_WINDOW_MS) }
        }
    });
    for (const meetup of candidates) {
        const proposerUser = await User.findOne({ where: { deviceId: meetup.proposerDeviceId } });
        if (!proposerUser) continue;

        const timing = resolveSosTiming(proposerUser);
        const windowMs = timing.silentMeetupWindowDays * 86400000;
        if (meetup.scheduledAt.getTime() > Date.now() - windowMs) continue; // not actually due yet for THIS user's own setting

        const confirmations = await MeetupConfirmation.count({ where: { meetupId: meetup.id } });
        const comfortConfirmed = meetup.meetupType === 'comfort'
            ? await ComfortMeetConfirmation.count({ where: { meetupId: meetup.id } })
            : 0;
        if (confirmations > 0 || comfortConfirmed > 0) continue;

        const alreadyAlerted = await EmergencyAlert.findOne({
            where: { ownerDeviceId: meetup.proposerDeviceId, triggerType: 'meetup_panic', distressSignature: { [Op.like]: `%meetup #${meetup.id}%` } }
        });
        if (alreadyAlerted) continue;

        const hasConfirmedContact = await EmergencyContact.count({ where: { ownerDeviceId: meetup.proposerDeviceId, status: 'confirmed' } });
        if (hasConfirmedContact === 0) continue; // nothing to notify — don't create a dead-end alert

        const counterpartyName = await resolveCounterpartyName(meetup);
        const signature = `Scheduled meetup #${meetup.id} with ${counterpartyName} was never confirmed by either side ${timing.silentMeetupWindowDays} days after the planned time.`;
        const now = Date.now();
        const alert = await EmergencyAlert.create({
            ownerDeviceId: meetup.proposerDeviceId,
            triggerType: 'meetup_panic',
            latitude: meetup.latitude,
            longitude: meetup.longitude,
            distressSignature: signature,
            status: 'active',
            escalateAt: new Date(now + ESCALATION_WINDOW_MS),
            nextCommunityBroadcastAt: new Date(now + timing.communityBroadcastDelayDays * 86400000),
            fullDetailAt: new Date(now + timing.fullDetailWindowDays * 86400000)
        });

        await notifyConfirmedContacts(alert, proposerUser, signature, counterpartyName);
        logger.info(`🆘 Meetup ${meetup.id} unconfirmed ${timing.silentMeetupWindowDays} days (this user's own setting) past scheduled time — raised and notified contacts for device ${meetup.proposerDeviceId}`);
    }
};
