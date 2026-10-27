import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { EmailAccountConfig } from '../models/EmailAccountConfig';
import { decrypt } from '../utils/secretCrypto';

export interface InboxMessage {
    uid: number;
    from: string | null;
    subject: string | null;
    date: string | null;
    seen: boolean;
}

const openClient = (config: EmailAccountConfig): ImapFlow => {
    return new ImapFlow({
        host: config.imapHost,
        port: config.imapPort,
        secure: config.imapSecure,
        auth: { user: config.username, pass: decrypt(config.encryptedPassword) },
        logger: false
    });
};

/** One-time login check at connect time — surfaces a wrong password/host immediately instead of only on the first real fetch. */
export const verifyImapLogin = async (config: EmailAccountConfig): Promise<void> => {
    const client = openClient(config);
    await client.connect();
    await client.logout();
};

/**
 * Most recent [limit] messages in INBOX, newest first. Opens a fresh
 * connection per call rather than pooling — simpler, and consistent with
 * every other route in this backend being stateless; IMAP's per-connection
 * cost is acceptable at this app's current call volume.
 */
export const fetchInbox = async (config: EmailAccountConfig, limit: number = 30): Promise<InboxMessage[]> => {
    const client = openClient(config);
    await client.connect();
    const messages: InboxMessage[] = [];
    try {
        const lock = await client.getMailboxLock('INBOX');
        try {
            const status = await client.status('INBOX', { messages: true });
            const total = status.messages || 0;
            if (!total) return [];
            const start = Math.max(1, total - limit + 1);
            for await (const msg of client.fetch(
                `${start}:*`,
                { envelope: true, flags: true, uid: true }
            )) {
                messages.push({
                    uid: msg.uid,
                    from: msg.envelope?.from?.[0]?.address || msg.envelope?.from?.[0]?.name || null,
                    subject: msg.envelope?.subject || null,
                    date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
                    seen: msg.flags?.has('\\Seen') ?? false
                });
            }
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
    return messages.reverse(); // newest first
};

export const fetchMessage = async (config: EmailAccountConfig, uid: number): Promise<{ subject: string | null; from: string | null; date: string | null; text: string | null; html: string | null }> => {
    const client = openClient(config);
    await client.connect();
    try {
        const lock = await client.getMailboxLock('INBOX');
        try {
            const { content } = await client.download(String(uid), undefined, { uid: true });
            const parsed = await simpleParser(content);
            // Mark as read now that the user actually opened it.
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            return {
                subject: parsed.subject || null,
                from: parsed.from?.text || null,
                date: parsed.date ? parsed.date.toISOString() : null,
                text: parsed.text || null,
                html: typeof parsed.html === 'string' ? parsed.html : null
            };
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
};

export const sendFromAccount = async (config: EmailAccountConfig, toEmail: string, subject: string, body: string): Promise<void> => {
    const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth: { user: config.username, pass: decrypt(config.encryptedPassword) }
    });
    await transporter.sendMail({
        from: config.emailAddress,
        to: toEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; white-space: pre-wrap;">${body}</div>`
    });
};
