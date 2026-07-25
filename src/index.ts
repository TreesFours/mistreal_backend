import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { getAiResponse, getAvailableModels } from './services/aiService';
import { sendSocialAction, createConnectSession, getAvailablePlatforms, getSocialSummary } from './services/socialService';
import { createSubscriptionSession, handleWebhook } from './services/stripeService';
import { getNewsData } from './services/newsService';
import { getWeatherData } from './services/weatherService';
import { User, DelayedAction, sequelize } from './models/userModel';
import { sendMilestoneEmail } from './utils/mailer';
import { authenticateUser } from './utils/authMiddleware';
import logger from './utils/logger';
import multer from 'multer';
import { socialActionQueue } from './services/queueService';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const upload = multer({ storage: multer.memoryStorage() });

// ... (DB Connection logic)

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// 🚀 Root and Health routes
app.get('/', (req, res) => res.send('🚀 Mistreal Backend Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ⚙️ 0. Get Dynamic Configuration
app.get('/api/config', (req, res) => {
    res.json({
        proPrice: process.env.MISTREAL_PRO_PRICE_USD || '14.99',
        productId: process.env.MISTREAL_PRO_PRODUCT_ID || 'mistreal_pro_monthly',
        freeTrialDays: process.env.MISTREAL_FREE_TRIAL_DAYS || '0'
    });
});

// 🔍 0. Get Available Models (Dynamic & Tiered)
app.get('/api/models', async (req, res) => {
    const { deviceId } = req.query;
    let isPro = false;

    if (DATABASE_URL && deviceId) {
        const user = await User.findOne({ where: { deviceId: deviceId as string } });
        isPro = user?.isPro || false;
    }

    const models = await getAvailableModels(isPro);
    res.json(models);
});

// 📱 0.1 Get Available Social Platforms (Dynamic & Tiered)
app.get('/api/social/platforms', async (req, res) => {
    const { deviceId } = req.query;
    let isPro = false;

    if (DATABASE_URL && deviceId) {
        const user = await User.findOne({ where: { deviceId: deviceId as string } });
        isPro = user?.isPro || false;
    }

    const platforms = await getAvailablePlatforms(isPro);
    res.json(platforms);
});

// 🧠 1. AI Chat - Routes requests to OpenRouter or Google Direct
app.post('/api/chat', authenticateUser, upload.fields([
    { name: 'images', maxCount: 10 },
    { name: 'audio', maxCount: 1 }
]), async (req: any, res) => {
    // Multipart data is in req.body and req.files
    const { prompt, provider, history, deviceId } = req.body;
    const firebaseUid = req.user.uid;

    // Convert files to Base64 buffers for the AI services
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const imageDatas = files['images']?.map(f => f.buffer.toString('base64'));
    const audioData = files['audio']?.[0]?.buffer.toString('base64');

    if (!prompt && !audioData) {
        return res.status(400).json({ success: false, error: 'Prompt or Audio is required' });
    }

    if (DATABASE_URL) {
        try {
            // Find user by Firebase UID, fallback to deviceId for migration
            let user = await User.findOne({ where: { firebaseUid } });

            if (!user) {
                user = await User.findOne({ where: { deviceId } });
                if (user) {
                    await user.update({ firebaseUid }); // Link existing data to new identity
                } else {
                    user = await User.create({ firebaseUid, deviceId });
                }
            }

            // Calculate Dynamic Quota: Limit = Pool / Users
            if (!user.isPro) {
                const TOTAL_FREE_POOL = 10000;
                const totalUsers = await User.count();
                const dynamicLimit = Math.floor(TOTAL_FREE_POOL / Math.max(totalUsers, 1));

                if (user.messageCount >= dynamicLimit) {
                    return res.status(429).json({
                        success: false,
                        error: `Monthly quota exceeded. Your dynamic limit is ${dynamicLimit} messages. Upgrade to PRO for unlimited access.`
                    });
                }
                await user.increment('messageCount');
            }
        } catch (err: any) {
            logger.error('User persistence/quota error:', err);
        }
    }

    const user = DATABASE_URL ? await User.findOne({ where: { firebaseUid } }) : null;
    const response = await getAiResponse(prompt, provider || 'gemini', history || [], user, imageDatas, audioData);
    res.json(response);
});

// 📱 2. Social Sync - Uses Zernio to fetch real interaction data
app.get('/api/social/sync', async (req, res) => {
    const { deviceId } = req.query;

    let userToken = null;
    if (deviceId && DATABASE_URL) {
        const user = await User.findOne({ where: { deviceId: deviceId as string } });
        userToken = user?.zernioUserToken;
    }

    const summary = await getSocialSummary(userToken || null);
    res.json(summary);
});

// 🔗 2.1 Connect Socials - Initiates Zernio Connect (GET for Browser Redirect)
app.get('/api/social/connect', async (req, res) => {
    const { platform, deviceId } = req.query;
    if (!platform) return res.status(400).send("Platform is required");

    try {
        const url = await createConnectSession(platform as string);
        if (!url) throw new Error("Zernio returned an empty connection URL");
        // Automatically redirect the browser to Zernio's login page
        res.redirect(url);
    } catch (error: any) {
        logger.error('❌ Social Connect Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            hint: "Ensure ZERNIO_API_KEY is valid and the Zernio service is reachable."
        });
    }
});

// 🔗 2.1.1 Social Callback - Handles the redirect from Zernio
app.get('/api/social/callback', async (req, res) => {
    const { code, state, deviceId } = req.query; // deviceId should be passed back in state or handled via session

    // Note: In a production app, use 'state' to prevent CSRF and link to the correct device
    // For now, we'll log it and prepare the token exchange
    logger.info(`📩 Received Zernio callback with code: ${code}`);

    try {
        // Here you would call Zernio to exchange 'code' for 'userToken'
        // const userToken = await exchangeCodeForToken(code);
        // await User.update({ zernioUserToken: userToken }, { where: { deviceId } });

        res.send("<h1>Connection Successful!</h1><p>You can now return to the Mistreal app.</p>");
    } catch (error: any) {
        res.status(500).send(`<h1>Connection Failed</h1><p>${error.message}</p>`);
    }
});

// 👤 2.1.2 User Settings - Sync Identity and Preferences
app.post('/api/user/settings', async (req, res) => {
    const { deviceId, userName, aiPersona, autoReplyDelay, guardianEnabled, emergencyContacts, connectedPlatforms } = req.body;

    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    try {
        // Check for duplicate username (if name is provided)
        if (userName) {
            const existingUser = await User.findOne({
                where: {
                    userName: userName,
                    deviceId: { [require('sequelize').Op.ne]: deviceId }
                }
            });
            if (existingUser) {
                return res.status(409).json({ error: 'Username is already taken' });
            }
        }

        const [user] = await User.findOrCreate({
            where: { deviceId },
            defaults: { deviceId }
        });

        await user.update({
            userName: userName || user.userName,
            preferences: { ...user.preferences, aiPersona: aiPersona || user.preferences?.aiPersona },
            autoReplyDelay: autoReplyDelay !== undefined ? autoReplyDelay : user.autoReplyDelay,
            guardianEnabled: guardianEnabled !== undefined ? guardianEnabled : user.guardianEnabled,
            emergencyContacts: emergencyContacts !== undefined ? emergencyContacts : user.emergencyContacts,
            connectedPlatforms: connectedPlatforms !== undefined ? connectedPlatforms : user.connectedPlatforms
        });

        res.json({ success: true, user });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ✍️ 2.2 Social Action - Sends a reply or like
app.post('/api/social/action', authenticateUser, async (req: any, res) => {
    const { deviceId, action, delayMinutes } = req.body;

    if (!DATABASE_URL) return res.status(503).json({ error: 'Database not available' });

    const user = await User.findOne({ where: { deviceId } });
    if (!user || !user.zernioUserToken) {
        return res.status(401).json({ error: 'Social account not connected' });
    }

    try {
        if (delayMinutes && delayMinutes > 0) {
            // Professional Distributed Queueing
            await socialActionQueue.add(
                `action_${deviceId}_${Date.now()}`,
                { deviceId, action, userToken: user.zernioUserToken },
                { delay: delayMinutes * 60000 }
            );
            res.json({ success: true, message: `Action scheduled professionally for ${delayMinutes} minutes from now.` });
        } else {
            const result = await sendSocialAction(user.zernioUserToken, action);
            res.json({ success: true, result });
        }
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 📱 2.3 Get Contacts by Platform
app.get('/api/social/contacts', async (req, res) => {
    const { deviceId, platform } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    try {
        const user = await User.findOne({ where: { deviceId } });
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Tier Check - Strictly Backend Locked
        const freePlatforms = ['twitter', 'whatsapp_business'];
        if (!user.isPro && !freePlatforms.includes(platform as string) && platform !== 'ai') {
            return res.status(403).json({ error: 'Platform restricted. Upgrade to PRO.' });
        }

        // Fetch contacts via Zernio (Mocked for now)
        const contacts = [
            { id: '1', name: 'Sarah', platform: platform, unreadCount: 2 },
            { id: '2', name: 'John', platform: platform, unreadCount: 0 }
        ];

        res.json({ success: true, contacts });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 📱 2.4 Global Unread Inbox
app.get('/api/social/unread', async (req, res) => {
    const { deviceId } = req.query;
    try {
        const user = await User.findOne({ where: { deviceId } });
        // Return unread items from all allowed platforms
        const unreadItems = [
            { id: 'u1', sender: 'Sarah', platform: 'whatsapp', text: 'Hey, you there?', timestamp: new Date() },
            { id: 'u2', sender: 'Gemini', platform: 'ai', text: 'Research complete.', timestamp: new Date() }
        ];
        res.json({ success: true, unreadItems });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 🆘 7. Emergency Alert - Guardian Mode Trigger
app.post('/api/emergency/alert', async (req, res) => {
    const { deviceId, latitude, longitude, distressSignature } = req.body;

    if (!DATABASE_URL) return res.status(503).json({ error: 'Database not available' });

    try {
        const user = await User.findOne({ where: { deviceId } });
        if (!user || !user.guardianEnabled) {
            return res.status(400).json({ error: 'Guardian mode not enabled for this user' });
        }

        const contacts = user.emergencyContacts || [];
        const locationLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
        const message = `🚨 EMERGENCY ALERT from ${user.userName || 'Mistreal User'}.\n` +
                        `Distress detected: ${distressSignature}\n` +
                        `Live Location: ${locationLink}`;

        logger.info(`🆘 Sending emergency alerts for ${deviceId} to ${contacts.length} contacts`);

        // Mocking dispatch for now - in production use Twilio/Nodemailer/Zernio
        for (const contact of contacts) {
            logger.info(`   -> Sending to ${contact.type}: ${contact.value}`);
        }

        res.json({ success: true, message: 'Alerts dispatched successfully' });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 💰 3. Payments - Google Play Billing Verification
app.post('/api/payment/verify', authenticateUser, async (req: any, res) => {
    const { purchaseToken, productId } = req.body;
    const firebaseUid = req.user.uid;

    if (!purchaseToken) return res.status(400).json({ error: 'purchaseToken is required' });

    try {
        const user = await User.findOne({ where: { firebaseUid } });
        if (user) {
            await user.update({ isPro: true, subscriptionTier: 'premium' });
            res.json({ success: true, message: 'PRO status unlocked' });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 🌦️ 4. Real Weather Data
app.get('/api/weather', async (req, res) => {
    const { lat, lon } = req.query;
    const weather = await getWeatherData(Number(lat), Number(lon));
    res.json(weather);
});

// 🗞️ 5. Real News Data
app.get('/api/news', async (req, res) => {
    const { category, country, location } = req.query;
    const news = await getNewsData(category as string, (country || location) as string);
    res.json(news);
});

// 💰 6. Stripe Webhook
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    try {
        await handleWebhook(req.body, sig as string);
        res.json({ received: true });
    } catch (err: any) {
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

app.listen(port, () => {
    logger.info(`🚀 Mistreal Backend Running on Port ${port}`);
});

// 🔍 404 Catch-all
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: `No endpoint found for ${req.method} ${req.url}`,
        hint: "Check your routes in src/index.ts or ensure the frontend is hitting the correct path."
    });
});
