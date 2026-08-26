/** 🛡️ AI SYSTEM PROTOCOL 🛡️
 * SOURCE OF TRUTH: master_system_map.artifact.md
 *
 * 🚀 FUNCTIONAL PIPELINE:
 * [Input]  <- Mobile App API requests (Chat, Social Sync, Weather, Map Data)
 * [Process] <- Orchestrates AI services, Social APIs, Stripe, and Intelligence Buffers
 * [Output] -> JSON responses to Frontend; persists location and social state in DB
 *
 * ⚠️ MANDATORY: Never delete history. Only ADD updates/fixes to the Master Map table.
 */
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';
import dotenv from 'dotenv';
import { Op } from 'sequelize';
import { getAiResponse, getAvailableModels, extractImageData, extractAudioData } from './services/aiService';
import { getSocialSummary, createConnectSession, sendSocialAction } from './services/socialService';
import { createSubscriptionSession, handleWebhook } from './services/stripeService';
import { getWeatherData } from './services/weatherService';
import { getDetailedAstroData, getJplVectorData } from './services/astroService';
import { IntelligenceService } from './services/intelligenceService';
import { getNearbyPlaces } from './services/discoveryService';
import { User, DelayedAction, IntelligenceBuffer } from './models/userModel';
import { PinnedIntel } from './models/PinnedIntel';
import { SocialToken } from './models/SocialToken';
import { sequelize } from './db';
import { verifyPurchase } from './services/googlePlayService';
import socialRoutes from './routes/socialRoutes';
import webhookRoutes from './routes/webhookRoutes';
import userRoutes from './routes/userRoutes';
import { validate, chatSchema, socialActionSchema, userSettingsSchema } from './middleware/validationMiddleware';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const upload = multer({ storage: multer.memoryStorage() });

// 🛡️ Helper: Get or Create User (Internal usage)
const getOrCreateUserInternal = async (deviceId: string, firebaseUid?: string) => {
    if (!DATABASE_URL) return null;
    try {
        // 🛡️ Zero-Defect Priority: If firebaseUid is provided, try to find by that first
        if (firebaseUid) {
            const userByUid = await User.findOne({ where: { firebaseUid } });
            if (userByUid) {
                // If deviceId differs, update it (continuity)
                if (userByUid.deviceId !== deviceId) {
                    userByUid.deviceId = deviceId;
                    await userByUid.save();
                }
                return userByUid;
            }
        }

        const [user, created] = await User.findOrCreate({
            where: { deviceId },
            defaults: { deviceId, firebaseUid, isPro: false, subscriptionTier: 'free' }
        });

        // Link firebaseUid if it wasn't linked yet
        if (!created && firebaseUid && !user.firebaseUid) {
            user.firebaseUid = firebaseUid;
            await user.save();
        }

        return user;
    } catch (e) { return null; }
};

// 🗄️ Database Connection
const initDb = async () => {
    if (DATABASE_URL) {
        try {
            // Set Node DNS to prefer IPv4 (Fixes ENETUNREACH on Render)
            const dns = require('dns');
            if (dns.setDefaultResultOrder) {
                dns.setDefaultResultOrder('ipv4first');
            }

            await sequelize.authenticate();
            await sequelize.sync({ alter: true });
            console.log('✅ DB Initialized');
        } catch (err: any) {
            console.error('❌ DB Init Failed:', err.message);
        }
    }
};

// 🛠️ Global Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// 🔗 Core Routes
app.use('/api/social', socialRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/user', userRoutes); // Combined /api/user/settings and /api/user/platforms

app.get('/', (req, res) => res.send('🚀 Mistreal Backend Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// 🧠 AI Chat
app.post('/api/chat', upload.fields([{ name: 'images', maxCount: 5 }, { name: 'audio', maxCount: 1 }]), validate(chatSchema), async (req, res) => {
    let { prompt, provider, history, deviceId, firebaseUid, contextMetadata } = req.body;
    const files = req.files as { images?: Express.Multer.File[], audio?: Express.Multer.File[] };

    if (typeof history === 'string') {
        try { history = JSON.parse(history); } catch (e) { history = []; }
    }

    const user = await getOrCreateUserInternal(deviceId, firebaseUid);

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

    // 🛡️ AI NOTE: If you overhaul or fix logic here, log it in the "History & Notes" column of the Master Map.
    res.json(response);
});

// 🔍 Model Catalog
app.get('/api/models', async (req, res) => {
    const { deviceId } = req.query;
    let isPro = false;
    if (deviceId) {
        const user = await getOrCreateUserInternal(String(deviceId));
        isPro = user?.isPro ?? false;
    }
    const models = await getAvailableModels(isPro);
    res.json(models);
});

// 📱 Legacy Social Routes (kept for backward compatibility, ideally move to socialRoutes)
app.get('/api/social/sync', async (req: Request, res: Response) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const user = await getOrCreateUserInternal(deviceId as string);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const summary = await getSocialSummary(user, user.isPro || false);
    res.json(summary);
});

// 💰 Stripe Sessions
app.post('/api/subscribe', async (req: any, res: any) => {
    const { tier, deviceId } = req.body;
    try {
        if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });
        await getOrCreateUserInternal(deviceId);
        const checkoutUrl = await createSubscriptionSession(tier, deviceId);
        res.json({ success: true, url: checkoutUrl });
    } catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
});

// 🌦️ Intelligence Feed
app.get('/api/weather', async (req, res) => {
    const { lat, lon, deviceId, firebaseUid } = req.query;

    // Proactive Cache Lookup
    if (deviceId) {
        const user = await getOrCreateUserInternal(deviceId as string, firebaseUid as string);
        if (user && user.lastWeatherSummary && user.lastLocationUpdate) {
            const lastUpdate = new Date(user.lastLocationUpdate).getTime();
            const now = new Date().getTime();
            // If cache is younger than 30 mins, serve it
            if (now - lastUpdate < 30 * 60 * 1000) {
                return res.json({
                    summary: user.lastWeatherSummary,
                    location: user.lastKnownCity,
                    rainExpected: false, // Could be parsed from summary
                    timeToRain: null
                });
            }
        }
    }

    const weather: any = await getWeatherData(Number(lat), Number(lon));

    // Update User Cache if possible
    if (deviceId && weather.summary !== "Weather unavailable") {
        const user = await getOrCreateUserInternal(deviceId as string, firebaseUid as string);
        if (user) {
            user.lastKnownLat = Number(lat);
            user.lastKnownLon = Number(lon);
            user.lastWeatherSummary = weather.summary;
            user.lastKnownCity = weather.location;
            user.lastLocationUpdate = new Date();
            await user.save();
        }
    }

    // Add Astro Summary to weather response for the top card
    try {
        const astroData = await getDetailedAstroData(Number(lat), Number(lon));
        if (astroData) {
            weather.celestial = {
                moon: astroData.moon,
                planets: astroData.planets
            };
            // Keep legacy fields for backward compatibility if needed,
            // but use structured data for the new UI.
            weather.moonPhase = astroData.moon.phase;
            weather.planets = astroData.planets.filter((p: any) => p.isVisible).map((p: any) => p.name).join(', ');
            weather.moonImageUrl = astroData.moon.imageUrl;
        }
    } catch (e) {}

    res.json(weather);
});

app.get('/api/news', async (req, res) => {
    const { firebaseUid, fastLoad } = req.query;

    if (firebaseUid) {
        // 🕒 NEW: Professional Interleaved Feed
        const feed = await IntelligenceService.getInterleavedFeed(String(firebaseUid), fastLoad === 'true');
        return res.json({ articles: feed });
    }

    // Fallback to legacy feed
    const news = await IntelligenceService.getGlobalFeed();
    res.json({ articles: news });
});

// 📌 Intelligence Pinning
app.post('/api/intel/pin', async (req, res) => {
    const { firebaseUid, itemTitle, itemUrl, itemType, metadata } = req.body;
    if (!firebaseUid || !itemTitle) return res.status(400).json({ success: false, error: 'Missing required fields' });

    try {
        await PinnedIntel.findOrCreate({
            where: { firebaseUid, itemTitle },
            defaults: { firebaseUid, itemTitle, itemUrl, itemType, metadata }
        });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/intel/unpin', async (req, res) => {
    const { firebaseUid, itemTitle } = req.body;
    try {
        await PinnedIntel.destroy({ where: { firebaseUid, itemTitle } });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 🔎 Nearby Discovery (real OSM points of interest, radius-aware)
app.get('/api/discovery/nearby', async (req, res) => {
    const { lat, lon, radius, category } = req.query;
    if (lat === undefined || lon === undefined || !category) {
        return res.status(400).json({ success: false, error: 'lat, lon, and category are required' });
    }

    const outcome = await getNearbyPlaces(
        Number(lat),
        Number(lon),
        radius !== undefined ? Number(radius) : 1000,
        String(category)
    );
    res.json({ results: outcome.results, succeeded: outcome.succeeded });
});

// 📍 Location Update Endpoint
app.post('/api/user/location', async (req, res) => {
    const { deviceId, firebaseUid, lat, lon } = req.body;
    if (!deviceId || lat === undefined || lon === undefined) {
        return res.status(400).json({ success: false, error: 'deviceId, lat, and lon required' });
    }
    const user = await getOrCreateUserInternal(deviceId, firebaseUid);
    if (user) {
        user.lastKnownLat = Number(lat);
        user.lastKnownLon = Number(lon);
        user.lastLocationUpdate = new Date();
        await user.save();

        // Trigger immediate proactive refresh for this specific user
        const weather = await getWeatherData(user.lastKnownLat, user.lastKnownLon);
        user.lastWeatherSummary = weather.summary;
        user.lastKnownCity = weather.location;
        await user.save();

        res.json({ success: true, location: user.lastKnownCity });
    } else {
        res.status(404).json({ success: false, error: 'User not found' });
    }
});

// 💰 Verification
app.post('/api/payment/verify', async (req, res) => {
    const { purchaseToken, productId, packageName } = req.body;
    try {
        const result = await verifyPurchase(packageName || 'com.example.mistreal_mini', productId, purchaseToken);
        res.json(result);
    } catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
});

// ⚙️ App Config
app.get('/api/config', async (req, res) => {
    res.json({
        proPrice: "$9.99/mo",
        productId: "pro_monthly_subscription",
        freeTrialDays: "7",
        freePlatformLimit: parseInt(process.env.FREE_USER_PLATFORM_LIMIT || '1', 10)
    });
});

// 🛰️ Celestial Precision Vectors
app.get('/api/celestial/vectors', async (req, res) => {
    const { bodyId } = req.query;
    if (!bodyId) return res.status(400).json({ success: false, error: 'bodyId required' });

    const { getJplVectorData } = require('./services/astroService');
    const data = await getJplVectorData(String(bodyId));

    if (data && data.result) {
        // Parse JPL Horizons response to extract relative orientation
        // Strategy: Use the most recent vector to determine azimuth/elevation
        const lines = data.result.split('\n');
        let x = 0, y = 0, z = 0;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('$$SOE')) {
                const vectorLine = lines[i+1]; // Line after start of ephemeris
                const parts = vectorLine.trim().split(/\s+/);
                // JPL Vector format: [JulianDate, X, Y, Z, VX, VY, VZ]
                x = parseFloat(parts[1]) || 0;
                y = parseFloat(parts[2]) || 0;
                z = parseFloat(parts[3]) || 0;
                break;
            }
        }

        // Convert Cartesian to Horizontal Coordinates (Approximate for list display)
        const azimuth = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        const elevation = Math.atan2(z, Math.sqrt(x*x + y*y)) * 180 / Math.PI;

        const orientation = getCompassDirection(azimuth);

        res.json({
            success: true,
            body: bodyId,
            azimuth,
            elevation,
            orientation,
            status: elevation > 0 ? "Visible" : "Below Horizon"
        });
    } else {
        res.status(500).json({ success: false, error: 'JPL Data unavailable' });
    }
});

function getCompassDirection(bearing: number): string {
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const index = Math.round(bearing / 45) % 8;
    return directions[index];
}

// ⏳ Background Worker: Intelligence Engine
setInterval(async () => {
    try {
        await IntelligenceService.refreshGlobalIntel();
    } catch (e) {
        console.error('❌ Global Intel Worker Error:', e);
    }
}, 60 * 60 * 1000); // Hourly

setInterval(async () => {
    try {
        await IntelligenceService.refreshProactiveWeather();
    } catch (e) {
        console.error('❌ Proactive Weather Worker Error:', e);
    }
}, 30 * 60 * 1000); // Every 30 mins

// ⏳ Background Worker: Delayed Social Actions
setInterval(async () => {
    if (!DATABASE_URL) return;
    try {
        const pendingActions = await DelayedAction.findAll({ where: { status: 'pending', executeAt: { [Op.lte]: new Date() } } });
        for (const action of pendingActions) {
            const user = await User.findOne({ where: { deviceId: action.deviceId } });
            if (user) {
                await sendSocialAction(user, { type: action.type, platform: action.platform, content: action.content, targetId: action.targetId });
                action.status = 'completed';
                await action.save();
            }
        }
    } catch (err: any) {}
}, 60000);

// 🔍 404 Catch-all
app.use((req, res) => {
    res.status(404).json({ success: false, error: `Endpoint NOT FOUND: ${req.method} ${req.url}` });
});

// Boot
initDb().then(async () => {
    // 🚀 BOOTSTRAP: Fill intelligence buffers immediately on start
    try {
        console.log('🚀 Triggering Intelligence Bootstrap...');
        await IntelligenceService.refreshGlobalIntel().catch(e => console.error('Intel Buffer Error:', e.message));
        console.log('✅ Intelligence Engine Bootstrapped');
    } catch (e: any) {
        console.error('⚠️ Intel Bootstrap failed:', e.message);
    }

    app.listen(port, () => { console.log(`🚀 Server Running on Port ${port}`); });
}).catch(err => {
    console.error('CRITICAL: Boot process failed:', err.message);
    app.listen(port, () => { console.log(`🚀 Emergency Mode: Server Running on Port ${port}`); });
});

// 🛡️ AI CHECKPOINT: Did you update the Master System Map? If not, do it now.
