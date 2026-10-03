import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { sendUserComposedEmail } from '../utils/mailer';
import { EmailMessage } from '../models/EmailMessage';
import logger from '../utils/logger';

const router = Router();

/**
 * ✉️ Compose-and-send email (no inbox sync — see EmailMessage.ts doc comment).
 */
router.post('/send', async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, toEmail, toName, subject, body } = req.body;
        if (!deviceId || !toEmail || !subject || !body) {
            return res.status(200).json({ success: false, error: 'deviceId, toEmail, subject and body are required' });
        }

        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) {
            return res.status(200).json({ success: false, error: 'User resolve failed' });
        }

        const senderName = user.userName || 'A Mistreal user';
        const sent = await sendUserComposedEmail(toEmail, subject, body, senderName);

        if (!sent) {
            return res.status(200).json({ success: false, error: 'Email delivery failed — check mail transport configuration.' });
        }

        await EmailMessage.create({ deviceId, toEmail, toName: toName || null, subject, body });

        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ POST /email/send error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

/**
 * 📜 Sent-message history with one address — the "thread" view.
 */
router.get('/history', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        const toEmail = req.query.toEmail as string;
        if (!deviceId || !toEmail) {
            return res.status(200).json({ success: false, messages: [] });
        }

        const messages = await EmailMessage.findAll({
            where: { deviceId, toEmail },
            order: [['timestamp', 'ASC']],
            limit: 100
        });

        res.json({
            success: true,
            messages: messages.map((m: any) => ({
                id: m.id,
                toEmail: m.toEmail,
                toName: m.toName,
                subject: m.subject,
                body: m.body,
                timestamp: m.timestamp
            }))
        });
    } catch (e: any) {
        logger.error(`❌ GET /email/history error: ${e.message}`);
        res.status(200).json({ success: false, messages: [] });
    }
});

/**
 * 📇 Distinct addresses this device has emailed before, most recent first —
 * populates the drawer's email panel without the user re-typing addresses.
 */
router.get('/contacts', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) {
            return res.status(200).json({ success: false, contacts: [] });
        }

        const messages = await EmailMessage.findAll({
            where: { deviceId, toEmail: { [Op.ne]: null } },
            order: [['timestamp', 'DESC']],
            limit: 200
        });

        const seen = new Map<string, any>();
        for (const m of messages as any[]) {
            if (!seen.has(m.toEmail)) {
                seen.set(m.toEmail, { toEmail: m.toEmail, toName: m.toName, lastSubject: m.subject, lastTimestamp: m.timestamp });
            }
        }

        res.json({ success: true, contacts: Array.from(seen.values()) });
    } catch (e: any) {
        logger.error(`❌ GET /email/contacts error: ${e.message}`);
        res.status(200).json({ success: false, contacts: [] });
    }
});

export default router;
