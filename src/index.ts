import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { getAiResponse, getAvailableModels } from './services/aiService';
import { getSocialSummary, createConnectSession, getAvailablePlatforms } from './services/socialService';
import { createSubscriptionSession, handleWebhook } from './services/stripeService';
import { getNewsData } from './services/newsService';
import { getWeatherData } from './services/weatherService';
import { User, DelayedAction, sequelize } from './models/userModel';
import { sendMilestoneEmail } from './utils/mailer';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// ... (DB Connection logic)

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// 🚀 Root and Health routes
app.get('/', (req, res) => res.send('🚀 Mistreal Backend Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

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
app.post('/api/chat', async (req, res) => {
    const { prompt, provider, history, deviceId } = req.body;

    if (!prompt) {
        return res.status(400).json({ success: false, error: 'Prompt is required' });
    }

    // 🛡️ 1.1 Quota Management (Dynamic Pool)
    const TOTAL_FREE_POOL = 10000; // Total free messages allowed per month for ALL users

    if (DATABASE_URL) {
        try {
            const [user, created] = await User.findOrCreate({
                where: { deviceId },
                defaults: { deviceId }
            });

            // If a new 100-user milestone is reached, notify the admin
            if (created) {
                const totalUsers = await User.count();
                if (totalUsers % 100 === 0 && totalUsers > 0) {
                    await sendMilestoneEmail(totalUsers);
                }
            }

            // Calculate Dynamic Quota: Limit = Pool / Users
            if (!user.isPro) {
                const totalUsers = await User.count();
                const dynamicLimit = Math.floor(TOTAL_FREE_POOL / Math.max(totalUsers, 1));

                if (user.messageCount >= dynamicLimit) {
                    return res.status(429).json({
                        success: false,
                        error: `Monthly quota exceeded. Your dynamic limit is ${dynamicLimit} messages. Upgrade to PRO for unlimited access.`
                    });
                }

                // Increment message count
                await user.increment('messageCount');
            }
        } catch (err: any) {
            console.error('User persistence/quota error:', err);
        }
    }

    const user = DATABASE_URL ? await User.findOne({ where: { deviceId } }) : null;
    const response = await getAiResponse(prompt, provider || 'gemini', history || [], user);
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
        console.error('❌ Social Connect Error:', error.message);
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
    console.log(`📩 Received Zernio callback with code: ${code}`);

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
    const { deviceId, userName, aiPersona, autoReplyDelay } = req.body;

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
            autoReplyDelay: autoReplyDelay !== undefined ? autoReplyDelay : user.autoReplyDelay
        });

        res.json({ success: true, user });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
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
app.post('/api/subscribe', async (req, res) => {
    const { tier, deviceId } = req.body;
    try {
        const checkoutUrl = await createSubscriptionSession(tier);
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

// ⏳ Background Worker for Delayed Actions
import { sendSocialAction } from './services/socialService';

setInterval(async () => {
    if (!DATABASE_URL) return;

    try {
        const pendingActions = await DelayedAction.findAll({
            where: {
                status: 'pending',
                executeAt: { [require('sequelize').Op.lte]: new Date() }
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

app.listen(port, () => {
    console.log(`🚀 Mistreal Backend Running on Port ${port}`);
});

// 🔍 404 Catch-all
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: `No endpoint found for ${req.method} ${req.url}`,
        hint: "Check your routes in src/index.ts or ensure the frontend is hitting the correct path."
    });
});
