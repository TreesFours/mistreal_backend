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
 * 🆘 Emergency-contact INVITE email — sent once, when the owner adds this
 * person. Nothing about an actual alert is in here; this only asks them to
 * confirm/decline the role via confirmUrl (a public, no-login landing page —
 * see emergencyRoutes.ts). Replaces the old one-directional flow where a
 * contact was never notified at all that they'd been listed.
 */
export const sendEmergencyContactInviteEmail = async (
    toEmail: string,
    contactName: string,
    ownerName: string,
    confirmUrl: string
): Promise<boolean> => {
    const transporter = getTransporter();
    const user = process.env.GMAIL_USER;
    if (!transporter || !user) {
        console.warn('⚠️ GMAIL_USER or GMAIL_APP_PASS not set. Emergency contact invite skipped.');
        return false;
    }

    const mailOptions = {
        from: user,
        to: toEmail,
        subject: `${ownerName} added you as an emergency contact on Mistreal`,
        text: `${contactName}, ${ownerName} has added you as their emergency contact on Mistreal. If something happens, you may be notified with their location and a way to check on them. Confirm or decline here: ${confirmUrl}`,
        html: `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                <h2 style="color: #D32F2F;">🛡️ Emergency Contact Request</h2>
                <p><strong>${contactName}</strong>, <strong>${ownerName}</strong> has added you as their emergency contact on Mistreal.</p>
                <p>If they ever trigger a safety alert, you may be notified with their last known location so you can check on them.</p>
                <p><a href="${confirmUrl}" style="display:inline-block;background:#D32F2F;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">Review &amp; Respond</a></p>
                <p style="color: #666; font-size: 12px;">You don't need to install anything to confirm or decline.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Emergency contact invite sent to ${toEmail}`);
        return true;
    } catch (error: any) {
        console.error(`❌ Error sending emergency contact invite to ${toEmail}:`, error.message);
        return false;
    }
};

/**
 * 🆘 A real fired alert, to an already-CONFIRMED contact only. Links to the
 * alert-detail/respond page (location + playable SOS audio + confirm-safe /
 * raise-concern buttons).
 */
export const sendEmergencyAlertNotificationEmail = async (
    toEmail: string,
    contactName: string,
    senderName: string,
    distressSignature: string,
    respondUrl: string
): Promise<boolean> => {
    const transporter = getTransporter();
    const user = process.env.GMAIL_USER;
    if (!transporter || !user) {
        console.warn('⚠️ GMAIL_USER or GMAIL_APP_PASS not set. Emergency alert email skipped.');
        return false;
    }

    const mailOptions = {
        from: user,
        to: toEmail,
        subject: `🆘 SOS Alert from ${senderName || 'a Mistreal contact'}`,
        text: `${contactName}, this is an emergency alert from ${senderName || 'your Mistreal contact'}.\n\nReason: ${distressSignature}\n\nView their location and respond: ${respondUrl}`,
        html: `
            <div style="font-family: sans-serif; padding: 20px; border: 2px solid #D32F2F;">
                <h2 style="color: #D32F2F;">🆘 SOS Alert</h2>
                <p><strong>${contactName}</strong>, this is an emergency alert from <strong>${senderName || 'your Mistreal contact'}</strong>.</p>
                <p>Reason: ${distressSignature}</p>
                <p><a href="${respondUrl}" style="display:inline-block;background:#D32F2F;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">View location &amp; respond</a></p>
                <p style="color: #666; font-size: 12px;">This alert was sent automatically by the Mistreal app.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Emergency alert email sent to ${toEmail}`);
        return true;
    } catch (error: any) {
        console.error(`❌ Error sending emergency alert email to ${toEmail}:`, error.message);
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
