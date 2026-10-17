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
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';
import dotenv from 'dotenv';
import { Op } from 'sequelize';
import { getAiResponse, getAvailableModels, extractImageData, extractAttachmentData, extractAudioData, extractVideoData, DOMAIN_PROVIDER_IDS } from './services/aiService';
import { getSocialSummary, createConnectSession, sendSocialAction } from './services/socialService';
import { getWeatherData } from './services/weatherService';
import { getDetailedAstroData } from './services/astroService';
import { IntelligenceService } from './services/intelligenceService';
import { getNearbyPlaces } from './services/discoveryService';
import { User, DelayedAction, IntelligenceBuffer } from './models/userModel';
import { PinnedIntel } from './models/PinnedIntel';
import { SocialToken } from './models/SocialToken';
import { EmailMessage } from './models/EmailMessage'; // imported for Sequelize registration — table is created by sequelize.sync below
import { AiProviderConfig } from './models/AiProviderConfig'; // same — registration only
import { Business } from './models/businessModel'; // same — registration only
import { Ad, AdEvent } from './models/adModel'; // same — registration only
import { sendMonthlyReportEmail } from './utils/mailer';
import { CommunityPost } from './models/communityModel'; // same — registration only
import { CachedYoutubeVideo } from './models/youtubeVideoModel'; // same — registration only
import { refreshCuratedVideos, getCachedVideos } from './services/youtubeService';
import { sequelize } from './db';
import { verifyPurchase } from './services/googlePlayService';
import socialRoutes from './routes/socialRoutes';
import webhookRoutes from './routes/webhookRoutes';
import businessRoutes from './routes/businessRoutes';
import meetupRoutes, { sweepSilentMeetups } from './routes/meetupRoutes';
import reviewRoutes from './routes/reviewRoutes';
import cloudStorageRoutes from './routes/cloudStorageRoutes';
import needRoutes from './routes/needRoutes';
import adRoutes from './routes/adRoutes';
import { ZernioAdapter } from './services/socialPlatforms/zernioAdapter';
import { getLocationPhoto } from './services/locationPhotoService';
import { ZERNIO_SUBSCRIBED_EVENTS } from './services/webhookService';
import userRoutes from './routes/userRoutes';
import { validate, chatSchema, socialActionSchema, userSettingsSchema } from './middleware/validationMiddleware';
import { getOrCreateUserInternal } from './utils/userResolver';
import { getStoredMedia } from './utils/mediaStore';
import aiProviderRoutes from './routes/aiProviderRoutes';
import emergencyRoutes from './routes/emergencyRoutes';
import emailRoutes from './routes/emailRoutes';
import marketRoutes from './routes/marketRoutes';
import { checkAlerts as checkMarketAlerts } from './services/marketDataService';
import { MarketAlert } from './models/MarketAlert'; // imported for Sequelize registration — table is created by sequelize.sync below
import { EmergencyContact } from './models/EmergencyContact'; // same — registration only
import { EmergencyAlert } from './models/EmergencyAlert'; // same — registration only
import { EmergencyAlertResponse } from './models/EmergencyAlertResponse'; // same — registration only
import { MeetupProposal } from './models/MeetupProposal'; // same — registration only
import { MeetupConfirmation } from './models/MeetupConfirmation'; // same — registration only
import { ComfortMeetConfirmation } from './models/ComfortMeetConfirmation'; // same — registration only
import { Review } from './models/Review'; // same — registration only
import { ReviewThreadMessage } from './models/ReviewThreadMessage'; // same — registration only
import { ReviewThreadParticipant } from './models/ReviewThreadParticipant'; // same — registration only
import { ReviewThreadInvite } from './models/ReviewThreadInvite'; // same — registration only
import { CloudStorageConfig } from './models/CloudStorageConfig'; // same — registration only
import { UserSkill } from './models/UserSkill'; // same — registration only
import { NeedPost } from './models/NeedPost'; // same — registration only
import { UserAddon } from './models/UserAddon';
import { getAddonCatalog, getAddonByPlayProductId } from './services/addonCatalog';
import { recomputeIsPro, hasAddon } from './services/addonService';
import { createCheckoutSession, handleStripeWebhook, createBillingPortalSession } from './services/stripeService';
import { WatchSession } from './models/WatchSession'; // imported for Sequelize registration — table is created by sequelize.sync below
import { registerWatchSignaling } from './services/watchSignalingService';
import { renderWatchViewerPage } from './utils/watchViewerPage';
import logger from './utils/logger';

dotenv.config();

const app = express();
const httpServer = http.createServer(app);
// Watch Hub (live screencast/share) signaling — pure relay, no video/audio
// ever passes through this process. A dedicated '/watch' namespace (set up
// in watchSignalingService.ts) keeps it isolated from any other future use
// of Socket.IO on this same server.
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
registerWatchSignaling(io);
const port = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB tactical limit
});

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
app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
}));
// Needed for the plain HTML <form method="POST"> confirm/response pages in
// emergencyRoutes.ts — those submit as application/x-www-form-urlencoded,
// not JSON, since they're meant to work for someone with no app installed.
app.use(express.urlencoded({ extended: true }));

// 🔗 Core Routes
app.use('/api/social', socialRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/user', userRoutes); // Combined /api/user/settings and /api/user/platforms
app.use('/api/ai-provider', aiProviderRoutes);
app.use('/api/emergency', emergencyRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/meetups', meetupRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/cloud-storage', cloudStorageRoutes);
app.use('/api/needs', needRoutes);
app.use('/api/ads', adRoutes);
app.use('/api/markets', marketRoutes);

app.get('/', (req, res) => res.send('🚀 Mistreal Backend Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// 🖼️ Short-lived media host — see mediaStore.ts. Lets AI-generated/edited
// images (which only exist as base64 in a chat response) be handed to Zernio
// as a fetchable URL for social DM delivery.
app.get('/media/:id', (req, res) => {
    const media = getStoredMedia(req.params.id);
    if (!media) return res.status(404).send('Not found or expired');
    res.set('Content-Type', media.mimeType);
    res.send(media.buffer);
});

// 📺 Universal Watch Hub viewer — a plain-browser counterpart to
// WatchViewerScreen.kt, so a Watch Hub host can cast to literally any
// device with a browser (a computer, a smart TV, anything), not only
// another Mistreal app. Speaks the exact same watchSignalingService.ts
// '/watch' Socket.IO protocol a native viewer does — join, receive an
// offer, answer, exchange ICE — using the browser's own native
// RTCPeerConnection instead of stream-webrtc-android. No app install, no
// account; the sessionId from WatchHostScreen's share code is the only
// credential needed. Validated as hex since it's echoed into the page.
app.get('/watch/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!/^[a-f0-9]+$/i.test(sessionId)) return res.status(400).send('Invalid session code');
    // helmet()'s default CSP (script-src 'self', no inline) would otherwise
    // silently block this page's inline WebRTC/Socket.IO script — relaxed
    // only on this one route, not globally.
    res.removeHeader('Content-Security-Policy');
    res.set('Content-Type', 'text/html');
    res.send(renderWatchViewerPage(sessionId));
});

// 🧠 AI Chat
app.post('/api/chat', upload.fields([{ name: 'images', maxCount: 5 }, { name: 'audio', maxCount: 1 }, { name: 'video', maxCount: 1 }]), validate(chatSchema), async (req, res) => {
    let { prompt, provider, history, deviceId, firebaseUid, contextMetadata, imageRoles, confirmArchRender, archUnderstanding } = req.body;
    const files = req.files as { images?: Express.Multer.File[], audio?: Express.Multer.File[], video?: Express.Multer.File[] };

    if (typeof history === 'string') {
        try { history = JSON.parse(history); } catch (e) { history = []; }
    }
    // Parallel to files.images, by position — e.g. ["start","end","character"].
    // Lets Scene Mode's keyframe-conditioned generation know which uploaded
    // image plays which role without needing a separate named field per role.
    if (typeof imageRoles === 'string') {
        try { imageRoles = JSON.parse(imageRoles); } catch (e) { imageRoles = undefined; }
    }
    // Multipart fields always arrive as strings — "true"/"false", never a
    // real boolean, same reason imageRoles needs its own JSON.parse above.
    confirmArchRender = confirmArchRender === true || confirmArchRender === 'true';

    const user = await getOrCreateUserInternal(deviceId, firebaseUid);

    if (!prompt && !files?.audio) {
        return res.status(400).json({ success: false, error: 'Prompt or audio is required' });
    }

    // A domain-config flow (Architectural Render etc.) allows PDFs alongside
    // images — every other caller still only ever gets 'image/jpeg' bytes,
    // same as before this existed, so nothing else needs to change.
    const isDomainFlow = provider && DOMAIN_PROVIDER_IDS.has(provider);
    const imageAttachments = (files?.images || []).map((f) =>
        isDomainFlow ? extractAttachmentData(f) : { base64: extractImageData(f), mimeType: 'image/jpeg' });
    const imageDatas = imageAttachments.map((a) => a.base64);
    const imageMimeTypes = imageAttachments.map((a) => a.mimeType);
    const audioData = files?.audio?.[0] ? extractAudioData(files.audio[0]) : undefined;
    const videoData = files?.video?.[0] ? extractVideoData(files.video[0]) : undefined;

    let enhancedPrompt = prompt;
    if (contextMetadata) {
        enhancedPrompt = `[CONTEXT: ${contextMetadata}]\n\nUser Question: ${prompt}`;
    }

    const response = await getAiResponse(enhancedPrompt, provider || 'gemini-1.5-flash', history || [], user, imageDatas, audioData, videoData, imageRoles, confirmArchRender, archUnderstanding, imageMimeTypes);

    // 🛡️ AI NOTE: If you overhaul or fix logic here, log it in the "History & Notes" column of the Master Map.
    res.json(response);
});

// 🔍 Model Catalog — gated on the specific ai_pro add-on, not generic isPro
// (which only means "has any add-on at all" — see addonService.ts).
app.get('/api/models', async (req, res) => {
    const { deviceId } = req.query;
    let hasAiPro = false;
    if (deviceId) {
        await getOrCreateUserInternal(String(deviceId));
        hasAiPro = await hasAddon(String(deviceId), 'ai_pro');
    }

    // 🛡️ Tactical Quota Calculation: Count total users to split shared resources
    const freeUserCount = await User.count({ where: { isPro: false } }) || 1;
    const proUserCount = await User.count({ where: { isPro: true } }) || 1;

    const models = await getAvailableModels(hasAiPro, freeUserCount, proUserCount);
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
    } catch (e: any) {
        console.warn('⚠️ Celestial enrichment on /api/weather failed (weather itself still returned):', e.message);
    }

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

// 🎬 Curated YouTube videos — served from the cache populated by
// refreshCuratedVideos(), never a live per-request search (see youtubeService.ts).
app.get('/api/feed/youtube', async (req, res) => {
    try {
        const videos = await getCachedVideos();
        res.json({ success: true, videos });
    } catch (e: any) {
        res.status(200).json({ success: false, videos: [], error: e.message });
    }
});

// 📷 Location photo — best-effort, returns null (not an error) if no photo
// API key is configured or no match is found; see locationPhotoService.ts.
app.get('/api/intel/location-photo', async (req, res) => {
    const { label, lat, lon } = req.query;
    if (!label || lat === undefined || lon === undefined) {
        return res.status(200).json({ success: false, photoUrl: null, error: 'label, lat and lon are required' });
    }
    try {
        const photoUrl = await getLocationPhoto(String(label), Number(lat), Number(lon));
        res.json({ success: true, photoUrl });
    } catch (e: any) {
        res.status(200).json({ success: false, photoUrl: null, error: e.message });
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

// 💰 Verification — previously never received deviceId and never wrote
// anything back to the User row: a real purchase was validated against
// Google but nothing was ever granted. Now resolves the purchased
// productId to a catalog add-on, upserts UserAddon, and recomputes isPro.
app.post('/api/payment/verify', async (req, res) => {
    const { deviceId, purchaseToken, productId, packageName } = req.body;
    if (!deviceId || !purchaseToken || !productId) {
        return res.status(200).json({ success: false, error: 'deviceId, purchaseToken and productId are required' });
    }
    try {
        const result = await verifyPurchase(packageName || 'com.example.mistreal_mini', productId, purchaseToken);
        if (!result.success) return res.json(result);

        const addon = getAddonByPlayProductId(productId);
        if (!addon) {
            logger.warn(`⚠️ /api/payment/verify: productId ${productId} doesn't match any known add-on — purchase verified with Google but nothing granted.`);
            return res.json({ ...result, warning: 'Verified but no matching add-on found.' });
        }

        await UserAddon.upsert({
            deviceId, addonId: addon.id, status: 'active', provider: 'play',
            playProductId: productId, playPurchaseToken: purchaseToken,
            expiresAt: result.expiryTime || null
        });
        const isPro = await recomputeIsPro(deviceId);

        res.json({ ...result, addonId: addon.id, isPro });
    } catch (error: any) {
        logger.error(`❌ /api/payment/verify error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/payment/my-addons', async (req, res) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, addons: [], error: 'deviceId required' });
        const rows = await UserAddon.findAll({ where: { deviceId, status: 'active' } });
        res.json({ success: true, addons: rows.map(r => r.addonId) });
    } catch (error: any) {
        res.status(200).json({ success: false, addons: [], error: error.message });
    }
});

// 💳 Stripe rail — only used by installs that didn't come from the Play
// Store (see billingRail.kt's install-source detection on the client). Play
// Store installs must use Play Billing per Google policy; everyone else uses
// this instead, so the same app works for both without two separate builds.
app.post('/api/payment/stripe/checkout', async (req, res) => {
    try {
        const { deviceId, addonId } = req.body;
        if (!deviceId || !addonId) {
            return res.status(200).json({ success: false, error: 'deviceId and addonId are required' });
        }
        const url = await createCheckoutSession(deviceId, addonId);
        res.json({ success: true, url });
    } catch (error: any) {
        logger.error(`❌ /api/payment/stripe/checkout error: ${error.message}`);
        res.status(200).json({ success: false, error: error.message });
    }
});

app.post('/api/payment/stripe/portal', async (req, res) => {
    try {
        const { deviceId } = req.body;
        if (!deviceId) return res.status(200).json({ success: false, error: 'deviceId is required' });
        const url = await createBillingPortalSession(deviceId);
        res.json({ success: true, url });
    } catch (error: any) {
        logger.error(`❌ /api/payment/stripe/portal error: ${error.message}`);
        res.status(200).json({ success: false, error: error.message });
    }
});

// Stripe needs the untouched raw body to verify the signature — already
// captured for every request by the express.json({verify}) call above, so
// no separately-ordered raw-body middleware is needed here.
app.post('/api/payment/stripe/webhook', async (req, res) => {
    try {
        const signature = req.headers['stripe-signature'] as string;
        await handleStripeWebhook((req as any).rawBody, signature);
        res.json({ received: true });
    } catch (error: any) {
        logger.error(`❌ /api/payment/stripe/webhook error: ${error.message}`);
        res.status(400).send(`Webhook Error: ${error.message}`);
    }
});

// No-login landing page the browser lands on after Stripe Checkout —
// mirrors emergencyRoutes/meetupRoutes' renderEmergencyPage/renderMeetupPage
// style. The app itself refreshes its add-on list via /api/payment/my-addons
// the next time it's foregrounded; this page is just a human-readable
// receipt for whoever is looking at the browser tab.
app.get('/api/payment/stripe/result', (req, res) => {
    const success = req.query.status === 'success';
    res.send(`
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${success ? 'Payment Complete' : 'Payment Canceled'} — Mistreal</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; margin: 0; padding: 32px 16px; }
        .card { background: #1e293b; padding: 32px; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); max-width: 480px; width: 100%; text-align: center; }
        h1 { color: ${success ? '#16a34a' : '#f87171'}; font-size: 22px; margin: 0 0 16px; }
        p { color: #cbd5e1; line-height: 1.5; }
        .brand { color: #64748b; font-size: 12px; margin-top: 24px; }
    </style>
</head>
<body>
    <div class="card">
        <h1>${success ? '✅ Payment Complete' : '✖️ Payment Canceled'}</h1>
        <p>${success ? 'Your add-on is now active. Return to the Mistreal app — it\'ll pick this up automatically.' : 'No charge was made. You can return to the Mistreal app and try again anytime.'}</p>
        <p class="brand">Mistreal</p>
    </div>
</body>
</html>`);
});

// ⚙️ App Config — freePlatformLimit/addons now drive the Subscription
// screen's checklist directly from env vars (see addonCatalog.ts), replacing
// the old single fixed-tier price/productId.
app.get('/api/config', async (req, res) => {
    res.json({
        proPrice: process.env.PRO_PRICE || "$9.99/mo",
        productId: process.env.PRO_PRODUCT_ID || "pro_monthly_subscription",
        freeTrialDays: process.env.FREE_TRIAL_DAYS || "7",
        freePlatformLimit: parseInt(process.env.FREE_USER_PLATFORM_LIMIT || '1', 10),
        // stripeAvailable rather than the raw price ID — the client only
        // ever needs to know whether the Stripe path exists for this
        // add-on, never the Stripe-side identifier itself.
        addons: getAddonCatalog().map(a => ({
            id: a.id, label: a.label, description: a.description,
            priceUsd: a.priceUsd, playProductId: a.playProductId,
            stripeAvailable: a.stripePriceId !== null
        }))
    });
});

// 📡 Watch Hub discovery — lets the Market/Meetup UI show "live now" without
// holding a socket open just to find out a session exists. The actual
// join/signaling happens over the '/watch' Socket.IO namespace.
app.get('/api/watch/sessions', async (req, res) => {
    try {
        const { contextType, contextId } = req.query;
        const where: any = { status: 'live' };
        if (contextType) where.contextType = contextType;
        if (contextId) where.contextId = contextId;
        const sessions = await WatchSession.findAll({ where, order: [['createdAt', 'DESC']] });
        res.json({ success: true, sessions });
    } catch (error: any) {
        res.status(200).json({ success: false, sessions: [], error: error.message });
    }
});

// 🏦 Bank official-channel directory — deep-links into a bank's own
// WhatsApp/Facebook chat only; this app never touches payments or credentials.
app.get('/api/banks/channels', async (req, res) => {
    try {
        const { country, deviceId } = req.query;
        let countryCode = country ? String(country) : undefined;
        if (!countryCode && deviceId) {
            const user = await User.findOne({ where: { deviceId: String(deviceId) } });
            countryCode = user?.lastKnownCountry || undefined;
        }
        const { getBankChannels } = require('./services/bankChannelRegistry');
        res.json({ success: true, banks: getBankChannels(countryCode) });
    } catch (e: any) {
        res.status(200).json({ success: false, banks: [], error: e.message });
    }
});

// 🛰️ Celestial Precision Vectors
app.get('/api/celestial/vectors', async (req, res) => {
    const { bodyId, lat, lon } = req.query;
    if (!bodyId) return res.status(400).json({ success: false, error: 'bodyId required' });

    const { getJplObserverData } = require('./services/astroService');
    const data = await getJplObserverData(
        String(bodyId),
        lat ? Number(lat) : 0,
        lon ? Number(lon) : 0
    );

    if (data) {
        res.json({
            success: true,
            ...data
        });
    } else {
        res.status(200).json({ success: false, body: String(bodyId), error: 'JPL Data unavailable' });
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

// Sports scores go stale much faster than news/wiki/etc, so this runs on its
// own tighter cadence instead of waiting for the hourly global intel refresh.
setInterval(async () => {
    try {
        await IntelligenceService.refreshSports();
    } catch (e) {
        console.error('❌ Sports Worker Error:', e);
    }
}, 10 * 60 * 1000); // Every 10 mins

// Price alerts need checking faster than the hourly news/wiki refresh, but
// not so fast it blows through Twelve Data's free daily quota — 15 min is a
// reasonable middle ground for a price-crossing alert (not a scalping tool).
setInterval(async () => {
    try {
        await checkMarketAlerts();
    } catch (e) {
        console.error('❌ Market Alert Worker Error:', e);
    }
}, 15 * 60 * 1000); // Every 15 mins

// YouTube's public Data API never gives a direct streamable video URL
// (that would violate their ToS) — this cache just feeds thumbnails/metadata
// into the feed; actual playback happens client-side via the official embed
// player. Long interval to stay well under the ~10,000-unit/day quota given
// search.list costs 100 units per curated query.
setInterval(async () => {
    try {
        await refreshCuratedVideos();
    } catch (e) {
        console.error('❌ YouTube Cache Worker Error:', e);
    }
}, 8 * 60 * 60 * 1000); // Every 8 hours

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

// 🆘 The old Guardian escalation sweep (an active EmergencyAlert past its
// 30-day escalateAt auto-posting to the OWNER'S OWN connected platforms)
// was removed here — it helped no one if the owner is actually missing,
// since it posted to their own disconnected accounts. Replaced by the
// community-broadcast tiers on GET /api/emergency/nearby-sos
// (emergencyRoutes.ts) — a live read-time check against
// nextCommunityBroadcastAt/fullDetailAt, not a one-time sweep side effect,
// so no interval is needed for it.

// 🤝 Silent-meetup sweep: a scheduled meetup nobody confirmed 4 days after
// the fact raises a real Guardian alert AND notifies confirmed contacts
// immediately (see meetupRoutes.ts) rather than a second, parallel
// notification system.
setInterval(async () => {
    if (!DATABASE_URL) return;
    try {
        await sweepSilentMeetups();
    } catch (err: any) {
        logger.error(`❌ Silent Meetup Sweep Error: ${err.message}`);
    }
}, 60 * 60 * 1000); // Hourly

// 📊 Monthly operator report: new/total user counts + per-business ad
// engagement, mailed to REPORT_EMAIL_TO. Checked hourly (matches the other
// sweeps' cadence) but only actually sends once, the first time this
// process observes the 1st of a new month — monthKey guard is in-memory
// only, same lightweight style as the rest of this codebase's ephemeral
// trackers (e.g. meetupRoutes.ts's ping map); a restart right at the
// boundary just means it might send once more, never a real problem for a
// once-a-month, mail-to-self report.
let lastMonthlyReportMonthKey: number | null = null;
setInterval(async () => {
    if (!DATABASE_URL) return;
    const now = new Date();
    if (now.getDate() !== 1) return;
    const monthKey = now.getFullYear() * 12 + now.getMonth();
    if (lastMonthlyReportMonthKey === monthKey) return;
    lastMonthlyReportMonthKey = monthKey;

    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const [newUserCount, totalUserCount, adEvents, ads, businesses] = await Promise.all([
            User.count({ where: { createdAt: { [Op.gte]: thirtyDaysAgo } } }),
            User.count(),
            AdEvent.findAll({ where: { createdAt: { [Op.gte]: thirtyDaysAgo } } }),
            Ad.findAll(),
            Business.findAll({ attributes: ['businessId', 'name'] })
        ]);

        const adById = new Map(ads.map(a => [a.id, a]));
        const nameByBusinessId = new Map(businesses.map(b => [b.businessId, b.name]));
        const statsByBusiness = new Map<string, { businessName: string; impressions: number; engagedClicks: number }>();

        for (const event of adEvents) {
            const ad = adById.get(event.adId);
            if (!ad) continue;
            const entry = statsByBusiness.get(ad.businessId) || {
                businessName: nameByBusinessId.get(ad.businessId) || ad.businessId,
                impressions: 0, engagedClicks: 0
            };
            if (event.eventType === 'impression') entry.impressions++;
            else if (event.eventType === 'engaged_click') entry.engagedClicks++;
            statsByBusiness.set(ad.businessId, entry);
        }

        await sendMonthlyReportEmail(
            newUserCount,
            totalUserCount,
            Array.from(statsByBusiness.entries()).map(([businessId, v]) => ({ businessId, ...v }))
        );
    } catch (err: any) {
        logger.error(`❌ Monthly Report Error: ${err.message}`);
    }
}, 60 * 60 * 1000); // Hourly check, only sends on the 1st

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
        refreshCuratedVideos().catch(e => console.error('YouTube Cache Bootstrap Error:', e.message)); // fire-and-forget, don't block boot
        console.log('✅ Intelligence Engine Bootstrapped');
    } catch (e: any) {
        console.error('⚠️ Intel Bootstrap failed:', e.message);
    }

    // Fire-and-forget: the webhook receiver (webhookRoutes.ts) has existed
    // for a while, but nothing ever told Zernio to actually send events to
    // it. Registration failure must never block server startup — same
    // fail-safe rule as everything else gated by an optional API key.
    if (process.env.ZERNIO_API_KEY) {
        ZernioAdapter.ensureWebhookRegistered(ZERNIO_SUBSCRIBED_EVENTS).catch(e =>
            console.error('⚠️ Zernio webhook registration failed at boot:', e.message)
        );
    }

    httpServer.listen(port, () => { console.log(`🚀 Server Running on Port ${port}`); });
}).catch(err => {
    console.error('CRITICAL: Boot process failed:', err.message);
    httpServer.listen(port, () => { console.log(`🚀 Emergency Mode: Server Running on Port ${port}`); });
});

// 🛡️ AI CHECKPOINT: Did you update the Master System Map? If not, do it now.
