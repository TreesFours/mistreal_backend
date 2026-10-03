import nodemailer from 'nodemailer';

const getTransporter = () => {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASS;
    if (!user || !pass) return null;
    return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
};

/**
 * ✉️ User-composed email, sent from the app's own transport (not the user's
 * personal address — there's no OAuth/inbox sync here, see emailRoutes.ts).
 * Reply-To is set to the sending user's own email if we have one on file, so
 * a reply from the recipient reaches them directly rather than the app's
 * shared sender account.
 */
export const sendUserComposedEmail = async (
    toEmail: string,
    subject: string,
    body: string,
    senderName: string,
    replyToEmail?: string | null
): Promise<boolean> => {
    const transporter = getTransporter();
    const user = process.env.GMAIL_USER;
    if (!transporter || !user) {
        console.warn('⚠️ GMAIL_USER or GMAIL_APP_PASS not set. Email send skipped.');
        return false;
    }

    const mailOptions = {
        from: `"${senderName} (via Mistreal)" <${user}>`,
        replyTo: replyToEmail || undefined,
        to: toEmail,
        subject,
        text: body,
        html: `<div style="font-family: sans-serif; white-space: pre-wrap;">${body}</div>`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ User-composed email sent to ${toEmail}`);
        return true;
    } catch (error: any) {
        console.error(`❌ Error sending user-composed email to ${toEmail}:`, error.message);
        return false;
    }
};

/**
 * 🆘 Emergency alert email to a saved emergency contact. Separate from the
 * milestone email's fire-and-forget pattern — callers (emergencyRoutes) need
 * the real success/failure per-contact to report back how many were notified.
 */
export const sendEmergencyAlertEmail = async (
    toEmail: string,
    contactName: string,
    senderName: string,
    distressSignature: string,
    latitude: number,
    longitude: number
): Promise<boolean> => {
    const transporter = getTransporter();
    const user = process.env.GMAIL_USER;
    if (!transporter || !user) {
        console.warn('⚠️ GMAIL_USER or GMAIL_APP_PASS not set. Emergency email skipped.');
        return false;
    }

    const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
    const mailOptions = {
        from: user,
        to: toEmail,
        subject: `🆘 SOS Alert from ${senderName || 'a Mistreal contact'}`,
        text: `${contactName}, this is an emergency alert from ${senderName || 'your Mistreal contact'}.\n\nReason: ${distressSignature}\nLast known location: ${mapsLink}\n\nThis alert was sent automatically by the Mistreal app.`,
        html: `
            <div style="font-family: sans-serif; padding: 20px; border: 2px solid #D32F2F;">
                <h2 style="color: #D32F2F;">🆘 SOS Alert</h2>
                <p><strong>${contactName}</strong>, this is an emergency alert from <strong>${senderName || 'your Mistreal contact'}</strong>.</p>
                <p>Reason: ${distressSignature}</p>
                <p>Last known location: <a href="${mapsLink}">${mapsLink}</a></p>
                <p style="color: #666; font-size: 12px;">This alert was sent automatically by the Mistreal app.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Emergency email sent to ${toEmail}`);
        return true;
    } catch (error: any) {
        console.error(`❌ Error sending emergency email to ${toEmail}:`, error.message);
        return false;
    }
};

export const sendMilestoneEmail = async (userCount: number) => {
    const transporter = getTransporter();
    const user = process.env.GMAIL_USER;

    if (!transporter || !user) {
        console.warn('⚠️ GMAIL_USER or GMAIL_APP_PASS not set. Milestone email skipped.');
        return;
    }

    const mailOptions = {
        from: user,
        to: user, // Sending to yourself
        subject: `🚀 Mistreal Milestone: ${userCount} Users!`,
        text: `Congratulations! Mistreal Mini has just reached ${userCount} total users in your database.\n\nKeep growing!`,
        html: `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee;">
                <h2 style="color: #6200EE;">🚀 Mistreal Milestone!</h2>
                <p>Congratulations! Mistreal Mini has just reached <strong>${userCount}</strong> total users.</p>
                <p style="color: #666; font-size: 12px;">This is an automated alert from your Mistreal Backend.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Milestone email sent for ${userCount} users.`);
    } catch (error) {
        console.error('❌ Error sending milestone email:', error);
    }
};
