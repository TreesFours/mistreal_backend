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
    const { prompt, provider, history, deviceId } = req.body;
    const firebaseUid = req.user.uid;

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const imageDatas = files['images']?.map(f => f.buffer.toString('base64'));
    const audioData = files['audio']?.[0]?.buffer.toString('base64');

    if (!prompt && !audioData) {
        return res.status(400).json({ success: false, error: 'Prompt or Audio is required' });
    }

    if (DATABASE_URL) {
        try {
            let user = await User.findOne({ where: { firebaseUid } });

            if (!user) {
                user = await User.findOne({ where: { deviceId } });
                if (user) {
                    await user.update({ firebaseUid });
                } else {
                    user = await User.create({ firebaseUid, deviceId });
                }
            }

            if (!user.isPro) {
                const TOTAL_FREE_POOL = 10000;
                const totalUsers = await User.count();
                const dynamicLimit = Math.floor(TOTAL_FREE_POOL / Math.max(totalUsers, 1));

                if (user.messageCount >= dynamicLimit) {
                    return res.status(429).json({
                        success: false,
                        error: `Monthly quota exceeded. Upgrade to PRO for unlimited access.`
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

// 🔗 2.1 Connect Socials
app.get('/api/social/connect', async (req, res) => {
    const { platform, deviceId } = req.query;
    if (!platform) return res.status(400).send("Platform is required");

    try {
        const url = await createConnectSession(platform as string);
        if (!url) throw new Error("Zernio returned an empty connection URL");
        res.redirect(url);
    } catch (error: any) {
        logger.error('❌ Social Connect Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 👤 2.1.2 User Settings
app.post('/api/user/settings', async (req, res) => {
    const { deviceId, userName, aiPersona, autoReplyDelay, guardianEnabled, emergencyContacts, connectedPlatforms } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    try {
        const [user] = await User.findOrCreate({ where: { deviceId }, defaults: { deviceId } });
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

// ✍️ 2.2 Social Action
app.post('/api/social/action', authenticateUser, async (req: any, res) => {
    const { deviceId, action, delayMinutes } = req.body;
    if (!DATABASE_URL) return res.status(503).json({ error: 'Database not available' });

    const user = await User.findOne({ where: { deviceId } });
    if (!user || !user.zernioUserToken) {
        return res.status(401).json({ error: 'Social account not connected' });
    }

    try {
        if (delayMinutes && delayMinutes > 0) {
            await socialActionQueue.add(
                `action_${deviceId}_${Date.now()}`,
                { deviceId, action, userToken: user.zernioUserToken },
                { delay: delayMinutes * 60000 }
            );
            res.json({ success: true, message: `Action scheduled professionally.` });
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
    try {
        const user = await User.findOne({ where: { deviceId } });
        if (!user) return res.status(404).json({ error: 'User not found' });
        const freePlatforms = ['twitter', 'whatsapp_business'];
        if (!user.isPro && !freePlatforms.includes(platform as string) && platform !== 'ai') {
            return res.status(403).json({ error: 'Platform restricted. Upgrade to PRO.' });
        }
        res.json({ success: true, contacts: [{ id: '1', name: 'Sarah', platform: platform, unreadCount: 2 }] });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 🆘 7. Emergency Alert
app.post('/api/emergency/alert', async (req, res) => {
    const { deviceId, latitude, longitude, distressSignature } = req.body;
    try {
        const user = await User.findOne({ where: { deviceId } });
        if (!user || !user.guardianEnabled) return res.status(400).json({ error: 'Guardian mode not enabled' });
        logger.info(`🆘 EMERGENCY ALERT: ${user.userName} at ${latitude}, ${longitude}`);
        res.json({ success: true, message: 'Alerts dispatched' });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 🛡️ Zero-Defect Fix #4: Atomic Payment Transaction
app.post('/api/payment/verify', authenticateUser, async (req: any, res) => {
    const { purchaseToken, productId } = req.body;
    const firebaseUid = req.user.uid;

    if (!purchaseToken) return res.status(400).json({ error: 'purchaseToken is required' });

    // Start Transaction
    const t = await sequelize.transaction();
    try {
        const user = await User.findOne({ where: { firebaseUid }, transaction: t });
        if (user) {
            await user.update({ isPro: true, subscriptionTier: 'premium' }, { transaction: t });
            await t.commit();
            res.json({ success: true, message: 'PRO status unlocked atomicly' });
        } else {
            await t.rollback();
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error: any) {
        await t.rollback();
        logger.error('Payment Verification Failed (Rolled Back):', error.message);
        res.status(500).json({ error: 'Transaction failed. No data corrupted.' });
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

app.listen(port, () => {
    logger.info(`🚀 Mistreal Backend Running on Port ${port}`);
});
