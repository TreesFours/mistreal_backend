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

// 🗄️ Database Connection
const initDb = async () => {
    if (DATABASE_URL) {
        try {
            // Force dynamic sync to add missing columns like firebaseUid
            await sequelize.authenticate();
            console.log('📡 Database connection established.');

            await sequelize.sync({ alter: true });
            console.log('✅ PostgreSQL Schema Sync Complete (ALTER SUCCESS)');
        } catch (err: any) {
            console.error('❌ PostgreSQL Schema Sync Failed:', err.message);
            // Fallback: simple sync
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

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// 🔗 NEW: Direct Social Platform Integration Routes
app.use('/api/social', socialRoutes);

// 📨 NEW: Webhook Routes
app.use('/api/webhook', webhookRoutes);

// 🚀 Root and Health routes
app.get('/', (req, res) => res.send('🚀 Mistreal Backend Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));


// 🧠 1. AI Chat - Professional Multipart Streaming
app.post('/api/chat', upload.fields([{ name: 'images', maxCount: 5 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
    const { prompt, provider, history, deviceId, contextMetadata } = req.body;
    const files = req.files as { images?: Express.Multer.File[], audio?: Express.Multer.File[] };

    if (!prompt && !files?.audio) {
        return res.status(400).json({ success: false, error: 'Prompt or audio is required' });
    }

    const imageDatas = files?.images?.map(extractImageData) || [];
    const audioData = files?.audio?.[0] ? extractAudioData(files.audio[0]) : undefined;

    const user = DATABASE_URL ? await User.findOne({ where: { deviceId } }) : null;

    // 🧠 Contextual Intelligence: If contextMetadata is provided, prepend it to the prompt
    let enhancedPrompt = prompt;
    if (contextMetadata) {
        enhancedPrompt = `[CONTEXT: ${contextMetadata}]\n\nUser Question: ${prompt}`;
    }

    const response = await getAiResponse(enhancedPrompt, provider || 'gemini', history || [], user, imageDatas, audioData);
    res.json(response);
});

// 🔍 Model Catalog
app.get('/api/models', async (req, res) => {
    const { deviceId } = req.query;
    let isPro = false;

    try {
        if (deviceId && DATABASE_URL) {
            const user = await User.findOne({ where: { deviceId: String(deviceId) } });
            isPro = user?.isPro ?? false;
        }
    } catch (e) {
        console.error("Error fetching user for models:", e);
    }

    const models = await getAvailableModels(isPro);
    res.json(models);
});

// 📱 Social Sync - NEW: Uses unified service for all 5 platforms
app.get('/api/social/sync-all', async (req, res) => {
    const { deviceId } = req.query;

    if (!deviceId) {
        return res.status(400).json({ error: 'deviceId is required' });
    }

    try {
        const user = DATABASE_URL ? await User.findOne({ where: { deviceId: deviceId as string } }) : null;
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Get all connected tokens from database
        const tokens = await SocialToken.findAll({ where: { deviceId: deviceId as string } });

        const userData: any = {
            deviceId: user.deviceId,
            zernioUserToken: user.zernioUserToken,
            isPro: user.isPro
        };

        // Populate tokens for the unified service
        tokens.forEach(t => {
            userData[`${t.platform}Token`] = t.accessToken;
        });

        const result = await UnifiedSocialService.syncAllPlatforms(userData);
        res.json(result);
    } catch (error: any) {
        console.error("Sync All Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 📱 Social Sync - LEGACY: Uses Zernio (for backward compatibility)
app.get('/api/social/sync', async (req, res) => {
    const { deviceId } = req.query;

    let userToken = null;
    let isPro = false;
    if (deviceId && DATABASE_URL) {
        const user = await User.findOne({ where: { deviceId: deviceId as string } });
        userToken = user?.zernioUserToken;
        isPro = user?.isPro || false;
    }

    const summary = await getSocialSummary(userToken || null, isPro);
    res.json(summary);
});

// 🔗 2.1 Connect Socials - Initiates Zernio Connect
app.post('/api/social/connect', async (req, res) => {
    const { platform, deviceId } = req.body;
    try {
        const url = await createConnectSession(platform);
        res.json({ success: true, url });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ✍️ 2.2 Social Action - Sends a reply or like
app.post('/api/social/action', async (req, res) => {
    const { deviceId, action, delayMinutes } = req.body;

    if (!DATABASE_URL) return res.status(503).json({ error: 'Database not available' });

    const user = await User.findOne({ where: { deviceId } });
    if (!user || !user.zernioUserToken) {
        return res.status(401).json({ error: 'Social account not connected' });
    }

    try {
        if (delayMinutes && delayMinutes > 0) {
            const executeAt = new Date(Date.now() + delayMinutes * 60000);
            await DelayedAction.create({
                deviceId,
                type: action.type,
                platform: action.platform,
                content: action.content,
                targetId: action.targetId,
                executeAt
            });
            res.json({ success: true, message: `Action scheduled for ${executeAt.toISOString()}` });
        } else {
            const result = await sendSocialAction(user.zernioUserToken, action);
            res.json({ success: true, result });
        }
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 💰 3. Payments - Triggers the real Stripe checkout flow
app.post('/api/subscribe', async (req: any, res: any) => {
    const { tier, deviceId } = req.body;
    try {
        if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });
        const checkoutUrl = await createSubscriptionSession(tier, deviceId);
        res.json({ success: true, url: checkoutUrl });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
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
    // Accept 'location' as an alias for 'country' to match Android frontend
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

// 💰 7. Google Play Payment Verification
app.post('/api/payment/verify', async (req, res) => {
    const { purchaseToken, productId, packageName } = req.body;
    try {
        const result = await verifyPurchase(packageName || 'com.example.mistreal_mini', productId, purchaseToken);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ⏳ Background Worker for Delayed Actions
setInterval(async () => {
    if (!DATABASE_URL) return;

    try {
        const pendingActions = await DelayedAction.findAll({
            where: {
                status: 'pending',
                executeAt: { [Op.lte]: new Date() }
            }
        });

        for (const action of pendingActions) {
            const user = await User.findOne({ where: { deviceId: action.deviceId } });
            if (user && user.zernioUserToken) {
                await sendSocialAction(user.zernioUserToken, {
                    type: action.type,
                    platform: action.platform,
                    content: action.content,
                    targetId: action.targetId
                });
                action.status = 'completed';
                await action.save();
                console.log(`✅ Delayed action executed for ${action.deviceId}`);
            }
        }
    } catch (err: any) {
        console.error('Error processing delayed actions:', err);
    }
}, 60000); // Check every minute

// 🔍 404 Catch-all
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: `No endpoint found for ${req.method} ${req.url}`,
        hint: "Check your routes in src/index.ts or ensure the frontend is hitting the correct path."
    });
});

// Execute DB initialization and start server
initDb().then(() => {
    app.listen(port, () => {
        console.log(`🚀 Mistreal Backend Running on Port ${port}`);
    });
});
