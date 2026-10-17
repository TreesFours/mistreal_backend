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

/**
 * Permanent, app-independent incident record — sent to a FIXED env-var
 * destination (SOS_ARCHIVE_EMAIL), deliberately never user-configurable,
 * so the details survive an app delete/uninstall rather than living only
 * on the device. Fires once per alert (both manual SOS and a meetup-panic
 * dead-man's-switch), at the same moment confirmed contacts are notified.
 */
export const sendSosArchiveEmail = async (
    alert: { id: number; triggerType: string; latitude: number; longitude: number; sosAudioUrl: string | null; sosImageUrl: string | null; distressSignature: string | null },
    ownerName: string,
    ownerDeviceId: string,
    counterpartyName: string | null
): Promise<void> => {
    const transporter = getTransporter();
    const user = process.env.GMAIL_USER;
    const toEmail = process.env.SOS_ARCHIVE_EMAIL;
    if (!transporter || !user || !toEmail) {
        console.warn('⚠️ GMAIL_USER/GMAIL_APP_PASS/SOS_ARCHIVE_EMAIL not fully set. SOS archive email skipped.');
        return;
    }

    const mapsLink = `https://www.google.com/maps?q=${alert.latitude},${alert.longitude}`;
    const counterpartyLine = counterpartyName ? `\nScheduled to meet: ${counterpartyName}` : '';

    const mailOptions = {
        from: user,
        to: toEmail,
        subject: `🆘 [Archive] SOS alert #${alert.id} — ${ownerName}`,
        text: `Alert #${alert.id} (${alert.triggerType}) for ${ownerName} (device ${ownerDeviceId}).\n\nReason: ${alert.distressSignature || 'n/a'}${counterpartyLine}\nLast known location: ${mapsLink}\nVoice note: ${alert.sosAudioUrl || '(none captured)'}\nPhoto: ${alert.sosImageUrl || '(none attached)'}`,
        html: `
            <div style="font-family: sans-serif; padding: 20px; border: 2px solid #D32F2F;">
                <h2 style="color: #D32F2F;">🆘 SOS Archive — Alert #${alert.id}</h2>
                <p><strong>${ownerName}</strong> (device ${ownerDeviceId}) — trigger: ${alert.triggerType}</p>
                <p>Reason: ${alert.distressSignature || 'n/a'}</p>
                ${counterpartyName ? `<p>Scheduled to meet: <strong>${counterpartyName}</strong></p>` : ''}
                <p>Last known location: <a href="${mapsLink}">${mapsLink}</a></p>
                <p>Voice note: ${alert.sosAudioUrl ? `<a href="${alert.sosAudioUrl}">${alert.sosAudioUrl}</a>` : '(none captured)'}</p>
                <p>Photo: ${alert.sosImageUrl ? `<a href="${alert.sosImageUrl}">${alert.sosImageUrl}</a>` : '(none attached)'}</p>
                <p style="color: #666; font-size: 12px;">Permanent incident record — this email is the only copy that survives an app delete/uninstall.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ SOS archive email sent for alert ${alert.id}`);
    } catch (error: any) {
        console.error(`❌ Error sending SOS archive email for alert ${alert.id}:`, error.message);
    }
};

/**
 * Monthly operator report — new users in the past 30 days, total
 * registered users, and per-business ad engagement for the same window.
 * Sent to REPORT_EMAIL_TO (falls back to GMAIL_USER, same "mail yourself"
 * pattern sendMilestoneEmail already established) — see index.ts's
 * monthly interval for what triggers this and how the numbers are
 * computed.
 */
export const sendMonthlyReportEmail = async (
    newUserCount: number,
    totalUserCount: number,
    adStats: { businessId: string; businessName: string; impressions: number; engagedClicks: number }[]
) => {
    const transporter = getTransporter();
    const user = process.env.GMAIL_USER;
    const toEmail = process.env.REPORT_EMAIL_TO || user;
    if (!transporter || !user || !toEmail) {
        console.warn('⚠️ GMAIL_USER/GMAIL_APP_PASS/REPORT_EMAIL_TO not fully set. Monthly report skipped.');
        return;
    }

    const adRows = adStats.length === 0
        ? '<tr><td colspan="3" style="color:#666;">No ad activity this period.</td></tr>'
        : adStats.map(a => `<tr><td>${a.businessName}</td><td>${a.impressions}</td><td>${a.engagedClicks}</td></tr>`).join('');

    const mailOptions = {
        from: user,
        to: toEmail,
        subject: `📊 Mistreal Monthly Report — ${newUserCount} new users`,
        text: `New users (last 30 days): ${newUserCount}\nTotal users: ${totalUserCount}\n\nAd engagement:\n${adStats.map(a => `${a.businessName}: ${a.impressions} impressions, ${a.engagedClicks} engaged clicks`).join('\n') || 'No ad activity this period.'}`,
        html: `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee;">
                <h2 style="color: #6200EE;">📊 Mistreal Monthly Report</h2>
                <p>New users (last 30 days): <strong>${newUserCount}</strong></p>
                <p>Total users: <strong>${totalUserCount}</strong></p>
                <h3>Ad engagement</h3>
                <table style="border-collapse: collapse; width: 100%;">
                    <tr><th align="left">Business</th><th align="left">Impressions</th><th align="left">Engaged clicks</th></tr>
                    ${adRows}
                </table>
                <p style="color: #666; font-size: 12px;">This is an automated monthly report from your Mistreal Backend.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Monthly report email sent to ${toEmail}`);
    } catch (error: any) {
        console.error('❌ Error sending monthly report email:', error.message);
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
