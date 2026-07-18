import nodemailer from 'nodemailer';

export const sendMilestoneEmail = async (userCount: number) => {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASS;

    if (!user || !pass) {
        console.warn('⚠️ GMAIL_USER or GMAIL_APP_PASS not set. Milestone email skipped.');
        return;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass }
    });

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
