import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { MarketAlert } from '../models/MarketAlert';
import { getQuote, getCandles } from '../services/marketDataService';
import logger from '../utils/logger';

const router = Router();

// A handful of majors everyone sees for free, independent of any user's own
// alerts — mirrors the Free/Premium split already used for AI models.
const SHARED_WATCHLIST = [
    { symbol: 'AAPL', assetClass: 'stock' },
    { symbol: 'MSFT', assetClass: 'stock' },
    { symbol: 'XAU/USD', assetClass: 'commodity' },
    { symbol: 'WTI/USD', assetClass: 'commodity' },
    { symbol: 'BTC', assetClass: 'crypto' },
    { symbol: 'ETH', assetClass: 'crypto' }
];

router.get('/watchlist', async (_req: Request, res: Response) => {
    try {
        const quotes = await Promise.all(
            SHARED_WATCHLIST.map(async ({ symbol, assetClass }) => ({
                ...(await getQuote(symbol, assetClass)),
                symbol, assetClass
            }))
        );
        const available = quotes.filter(q => q.price !== undefined);
        if (available.length < quotes.length) {
            // getQuote() already logged the specific cause per symbol above —
            // this line is the "requested N, got M" summary so a partial
            // watchlist is never silently mistaken for "everything's fine."
            const missing = quotes.filter(q => q.price === undefined).map(q => q.symbol);
            logger.warn(`⚠️ [Markets] /watchlist: ${available.length}/${quotes.length} quotes available — missing: ${missing.join(', ')}`);
        }
        res.json({ success: true, quotes: available });
    } catch (e: any) {
        logger.error(`❌ GET /markets/watchlist error: ${e.message}`);
        res.status(200).json({ success: false, quotes: [], error: e.message });
    }
});

router.get('/candles', async (req: Request, res: Response) => {
    try {
        const { symbol, assetClass } = req.query;
        if (!symbol || !assetClass) {
            return res.status(200).json({ success: false, candles: [], error: 'symbol and assetClass are required' });
        }
        const candles = await getCandles(String(symbol), String(assetClass));
        if (!candles) return res.status(200).json({ success: false, candles: [], error: 'Chart data unavailable for this symbol right now' });
        res.json({ success: true, candles });
    } catch (e: any) {
        logger.error(`❌ GET /markets/candles error: ${e.message}`);
        res.status(200).json({ success: false, candles: [], error: e.message });
    }
});

router.post('/alerts', async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, symbol, assetClass, direction, targetPrice } = req.body;
        if (!deviceId || !symbol || !assetClass || !direction || targetPrice === undefined) {
            return res.status(200).json({ success: false, error: 'deviceId, symbol, assetClass, direction and targetPrice are required' });
        }
        if (!['above', 'below'].includes(direction)) {
            return res.status(200).json({ success: false, error: "direction must be 'above' or 'below'" });
        }

        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });

        // Custom alerts are a Pro feature — the free shared watchlist above
        // needs no account at all, this is the gated, personal-watch layer.
        const existingCount = await MarketAlert.count({ where: { deviceId, active: true } });
        if (!user.isPro && existingCount >= 1) {
            return res.status(200).json({ success: false, error: 'Custom price alerts are a Pro feature. Upgrade to track more than one.' });
        }

        const alert = await MarketAlert.create({
            deviceId, firebaseUid: firebaseUid || null,
            symbol: String(symbol).toUpperCase(), assetClass, direction, targetPrice: Number(targetPrice)
        });
        res.json({ success: true, alert });
    } catch (e: any) {
        logger.error(`❌ POST /markets/alerts error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/alerts', async (req: Request, res: Response) => {
    try {
        const { deviceId } = req.query;
        if (!deviceId) return res.status(200).json({ success: false, alerts: [], error: 'deviceId required' });
        const alerts = await MarketAlert.findAll({ where: { deviceId: String(deviceId) }, order: [['createdAt', 'DESC']] });
        res.json({ success: true, alerts });
    } catch (e: any) {
        res.status(200).json({ success: false, alerts: [], error: e.message });
    }
});

router.delete('/alerts/:id', async (req: Request, res: Response) => {
    try {
        await MarketAlert.destroy({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

// Polled by the client's periodic worker — returns triggered-but-not-yet-
// shown alerts for this device, so an alert that fired while the app wasn't
// running still gets surfaced the next time it checks in.
router.get('/alerts/pending', async (req: Request, res: Response) => {
    try {
        const { deviceId } = req.query;
        if (!deviceId) return res.status(200).json({ success: false, alerts: [], error: 'deviceId required' });
        const alerts = await MarketAlert.findAll({
            where: { deviceId: String(deviceId), triggeredAt: { [Op.ne]: null }, delivered: false }
        });
        res.json({ success: true, alerts });
    } catch (e: any) {
        res.status(200).json({ success: false, alerts: [], error: e.message });
    }
});

router.post('/alerts/:id/acknowledge', async (req: Request, res: Response) => {
    try {
        await MarketAlert.update({ delivered: true }, { where: { id: req.params.id } });
        res.json({ success: true });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
