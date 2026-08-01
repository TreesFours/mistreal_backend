import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';
import dotenv from 'dotenv';
import { Op } from 'sequelize';
import { getAiResponse, getAvailableModels, extractImageData, extractAudioData } from './services/aiService';
import { getSocialSummary, createConnectSession, sendSocialAction } from './services/socialService';
import { createSubscriptionSession, handleWebhook } from './services/stripeService';
import { getNewsData } from './services/newsService';
import { getWeatherData } from './services/weatherService';
import { User, DelayedAction } from './models/userModel';
import { SocialToken } from './models/SocialToken';
import { sequelize } from './db';
import { verifyPurchase } from './services/googlePlayService';
import socialRoutes from './routes/socialRoutes';
import webhookRoutes from './routes/webhookRoutes';
import { UnifiedSocialService } from './services/socialPlatforms/unified';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const upload = multer({ storage: multer.memoryStorage() });

// 🛡️ Helper: Get or Create User
const getOrCreateUser = async (deviceId: string) => {
    if (!DATABASE_URL) return null;
    try {
        const [user, created] = await User.findOrCreate({
            where: { deviceId },
            defaults: {
                deviceId,
                isPro: false,
                subscriptionTier: 'free'
            }
        });
        if (created) console.log(`🆕 New user registered: ${deviceId}`);
        return user;
    } catch (e) {
        console.error(`❌ Error finding/creating user ${deviceId}:`, e);
        return null;
    }
};

// 🗄️ Database Connection
const initDb = async () => {
    if (DATABASE_URL) {
        try {
            await sequelize.authenticate();
            console.log('📡 Database connection established.');
            await sequelize.sync({ alter: true });
            console.log('✅ PostgreSQL Schema Sync Complete (ALTER SUCCESS)');
        } catch (err: any) {
            console.error('❌ PostgreSQL Schema Sync Failed:', err.message);
            try {
                await sequelize.sync();
                console.log('✅ PostgreSQL Safe Sync Complete');
            } catch (e: any) {
                console.error('❌ PostgreSQL Fatal Sync Error:', e.message);
            }
        }
    } else {
        console.warn('⚠️ DATABASE_URL not set. Running without persistence.');
    }
};

// 🛡️ Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

    // 🔗 Routes
    app.use('/api/social', socialRoutes);
    app.use('/api/webhook', webhookRoutes);

    app.get('/api/social/platforms', async (req, res) => {
        const { deviceId } = req.query;
        let isPro = false;
        if (deviceId) {
            const user = await getOrCreateUser(String(deviceId));
            isPro = user?.isPro ?? false;
        }
        const platforms = await getAvailablePlatforms(isPro);
        res.json(platforms);
    });

    app.get('/', (req, res) => res.send('🚀 Mistreal Backend Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// 🧠 AI Chat
app.post('/api/chat', upload.fields([{ name: 'images', maxCount: 5 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
    let { prompt, provider, history, deviceId, contextMetadata } = req.body;
    const files = req.files as { images?: Express.Multer.File[], audio?: Express.Multer.File[] };

    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });

    if (typeof history === 'string') {
        try { history = JSON.parse(history); } catch (e) { history = []; }
    }

    // Auto-create user on first interaction
    const user = await getOrCreateUser(deviceId);

    if (!prompt && !files?.audio) {
        return res.status(400).json({ success: false, error: 'Prompt or audio is required' });
    }

    const imageDatas = files?.images?.map(extractImageData) || [];
    const audioData = files?.audio?.[0] ? extractAudioData(files.audio[0]) : undefined;

    let enhancedPrompt = prompt;
    if (contextMetadata) {
        enhancedPrompt = `[CONTEXT: ${contextMetadata}]\n\nUser Question: ${prompt}`;
    }

    const response = await getAiResponse(enhancedPrompt, provider || 'gemini-1.5-flash', history || [], user, imageDatas, audioData);
    res.json(response);
});

// 🔍 Model Catalog
app.get('/api/models', async (req, res) => {
    const { deviceId } = req.query;
    let isPro = false;
    if (deviceId) {
        const user = await getOrCreateUser(String(deviceId));
        isPro = user?.isPro ?? false;
    }
    const models = await getAvailableModels(isPro);
    res.json(models);
});

// 📱 Social Sync
app.get('/api/social/sync-all', async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    try {
        const user = await getOrCreateUser(deviceId as string);
        if (!user) return res.status(404).json({ error: 'User system unavailable' });

        const tokens = await SocialToken.findAll({ where: { deviceId: deviceId as string } });
        const userData: any = { deviceId: user.deviceId, zernioUserToken: user.zernioUserToken, isPro: user.isPro };
        tokens.forEach(t => { userData[`${t.platform}Token`] = t.accessToken; });
        const result = await UnifiedSocialService.syncAllPlatforms(userData);
        res.json(result);
    } catch (error: any) {
        console.error("Sync All Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/social/sync', async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const user = await getOrCreateUser(deviceId as string);
    const summary = await getSocialSummary(user?.zernioUserToken || null, user?.isPro || false);
    res.json(summary);
});

app.post('/api/social/connect', async (req, res) => {
    const { platform, deviceId } = req.body;
    try {
        const url = await createConnectSession(platform);
        res.json({ success: true, url });
    } catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/social/action', async (req, res) => {
    const { deviceId, action, delayMinutes } = req.body;
    if (!DATABASE_URL) return res.status(503).json({ error: 'Database not available' });

    const user = await getOrCreateUser(deviceId);
    if (!user || !user.zernioUserToken) return res.status(401).json({ error: 'Social account not connected' });

    try {
        if (delayMinutes && delayMinutes > 0) {
            const executeAt = new Date(Date.now() + delayMinutes * 60000);
            await DelayedAction.create({ deviceId, type: action.type, platform: action.platform, content: action.content, targetId: action.targetId, executeAt });
            res.json({ success: true, message: `Action scheduled for ${executeAt.toISOString()}` });
        } else {
            const result = await sendSocialAction(user.zernioUserToken, action);
            res.json({ success: true, result });
        }
    } catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/user/settings', async (req: any, res: any) => {
    const { deviceId, userName, aiPersona, autoReplyDelay, guardianEnabled, emergencyContacts } = req.body;
    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });

    try {
        const user = await getOrCreateUser(deviceId);
        if (!user) return res.status(404).json({ success: false, error: 'User system unavailable' });

        if (userName !== undefined) user.userName = userName;
        if (aiPersona !== undefined) user.aiPersona = aiPersona;
        if (autoReplyDelay !== undefined) user.autoReplyDelay = autoReplyDelay;
        if (guardianEnabled !== undefined) user.guardianEnabled = guardianEnabled;
        if (emergencyContacts !== undefined) user.emergencyContacts = emergencyContacts;

        await user.save();
        res.json({ success: true, message: 'Settings secured successfully' });
    } catch (error: any) {
        console.error(`❌ Error updating settings for ${deviceId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/subscribe', async (req: any, res: any) => {
    const { tier, deviceId } = req.body;
    try {
        if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });
        await getOrCreateUser(deviceId); // Ensure user exists before subscription
        const checkoutUrl = await createSubscriptionSession(tier, deviceId);
        res.json({ success: true, url: checkoutUrl });
    } catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/weather', async (req, res) => {
    const { lat, lon } = req.query;
    const weather = await getWeatherData(Number(lat), Number(lon));
    res.json(weather);
});

app.get('/api/news', async (req, res) => {
    const { category, country, location } = req.query;
    const news = await getNewsData(category as string, (country || location) as string);
    res.json(news);
});

app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    try {
        await handleWebhook(req.body, sig as string);
        res.json({ received: true });
    } catch (err: any) { res.status(400).send(`Webhook Error: ${err.message}`); }
});

app.post('/api/payment/verify', async (req, res) => {
    const { purchaseToken, productId, packageName } = req.body;
    try {
        const result = await verifyPurchase(packageName || 'com.example.mistreal_mini', productId, purchaseToken);
        res.json(result);
    } catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
});

// ⏳ Background Worker
setInterval(async () => {
    if (!DATABASE_URL) return;
    try {
        const pendingActions = await DelayedAction.findAll({ where: { status: 'pending', executeAt: { [Op.lte]: new Date() } } });
        for (const action of pendingActions) {
            const user = await User.findOne({ where: { deviceId: action.deviceId } });
            if (user && user.zernioUserToken) {
                await sendSocialAction(user.zernioUserToken, { type: action.type, platform: action.platform, content: action.content, targetId: action.targetId });
                action.status = 'completed';
                await action.save();
                console.log(`✅ Delayed action executed for ${action.deviceId}`);
            }
        }
    } catch (err: any) { console.error('Error processing delayed actions:', err); }
}, 60000);

// 🔍 404 Catch-all
app.use((req, res) => {
    res.status(404).json({ success: false, error: `No endpoint found for ${req.method} ${req.url}` });
});

// Execute DB initialization and start server
initDb().then(() => {
    app.listen(port, () => { console.log(`🚀 Mistreal Backend Running on Port ${port}`); });
});
