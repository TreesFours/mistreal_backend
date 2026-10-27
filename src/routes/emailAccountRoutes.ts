import { Router, Request, Response } from 'express';
import { EmailAccountConfig } from '../models/EmailAccountConfig';
import { fetchInbox, fetchMessage, sendFromAccount, verifyImapLogin } from '../services/emailAccountService';
import { encrypt } from '../utils/secretCrypto';
import logger from '../utils/logger';

const router = Router();

// Password never leaves this server once saved — same write-only
// convention CloudStorageConfig/AI-provider-config endpoints already use.
const toSafeConfig = (config: EmailAccountConfig) => ({
    id: config.id,
    label: config.label,
    emailAddress: config.emailAddress,
    imapHost: config.imapHost,
    imapPort: config.imapPort,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    isActive: config.isActive
});

router.post('/connect', async (req: Request, res: Response) => {
    try {
        const { deviceId, label, emailAddress, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, username, password } = req.body;
        if (!deviceId || !label || !emailAddress || !imapHost || !smtpHost || !username || !password) {
            return res.status(200).json({ success: false, error: 'deviceId, label, emailAddress, imapHost, smtpHost, username and password are required' });
        }

        const draft = EmailAccountConfig.build({
            deviceId, label, emailAddress,
            imapHost, imapPort: imapPort || 993, imapSecure: imapSecure ?? true,
            smtpHost, smtpPort: smtpPort || 465, smtpSecure: smtpSecure ?? true,
            username, encryptedPassword: encrypt(password)
        });

        // Verify the credentials actually work before saving them — a typo'd
        // app password should fail here with a clear reason, not silently
        // save and only surface as a mysterious failure on the first fetch.
        try {
            await verifyImapLogin(draft);
        } catch (e: any) {
            return res.status(200).json({ success: false, error: `Couldn't log in: ${e.message}` });
        }

        await draft.save();
        res.json({ success: true, config: toSafeConfig(draft) });
    } catch (e: any) {
        logger.error(`❌ POST /email-account/connect error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/accounts', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, accounts: [], error: 'deviceId required' });
        const accounts = await EmailAccountConfig.findAll({ where: { deviceId }, order: [['createdAt', 'DESC']] });
        res.json({ success: true, accounts: accounts.map(toSafeConfig) });
    } catch (e: any) {
        res.status(200).json({ success: false, accounts: [], error: e.message });
    }
});

// Only one active account per device — same per-device rule as cloud storage.
router.post('/accounts/activate', async (req: Request, res: Response) => {
    try {
        const { deviceId, accountId } = req.body;
        if (!deviceId || !accountId) return res.status(200).json({ success: false, error: 'deviceId and accountId are required' });

        const target = await EmailAccountConfig.findOne({ where: { id: accountId, deviceId } });
        if (!target) return res.status(200).json({ success: false, error: 'Account not found for this device' });

        await EmailAccountConfig.update({ isActive: false }, { where: { deviceId } });
        target.isActive = true;
        await target.save();

        res.json({ success: true, config: toSafeConfig(target) });
    } catch (e: any) {
        logger.error(`❌ POST /email-account/accounts/activate error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.delete('/accounts/:id', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        await EmailAccountConfig.destroy({ where: { id: req.params.id, deviceId } });
        res.json({ success: true });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

const getActiveAccount = (deviceId: string) => EmailAccountConfig.findOne({ where: { deviceId, isActive: true } });

router.get('/inbox', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, messages: [], error: 'deviceId required' });

        const account = await getActiveAccount(deviceId);
        if (!account) return res.status(200).json({ success: false, messages: [], error: 'No connected email account for this device' });

        const messages = await fetchInbox(account);
        res.json({ success: true, messages });
    } catch (e: any) {
        logger.error(`❌ GET /email-account/inbox error: ${e.message}`);
        res.status(200).json({ success: false, messages: [], error: e.message });
    }
});

router.get('/messages/:uid', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, error: 'deviceId required' });

        const account = await getActiveAccount(deviceId);
        if (!account) return res.status(200).json({ success: false, error: 'No connected email account for this device' });

        const message = await fetchMessage(account, Number(req.params.uid));
        res.json({ success: true, message });
    } catch (e: any) {
        logger.error(`❌ GET /email-account/messages/:uid error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.post('/send', async (req: Request, res: Response) => {
    try {
        const { deviceId, toEmail, subject, body } = req.body;
        if (!deviceId || !toEmail || !subject || !body) {
            return res.status(200).json({ success: false, error: 'deviceId, toEmail, subject and body are required' });
        }

        const account = await getActiveAccount(deviceId);
        if (!account) return res.status(200).json({ success: false, error: 'No connected email account for this device' });

        await sendFromAccount(account, toEmail, subject, body);
        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ POST /email-account/send error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
