import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { MarketAlert } from '../models/MarketAlert';
import { getQuote, getCandles } from '../services/marketDataService';
import logger from '../utils/logger';

const router = Router();

// Was a deliberate "handful of majors" (4 crypto / 6 forex / 2 stocks / 2
// commodities) — too small to read as a real market ticker, and most of
// marketDataService.ts's own 31-coin COINGECKO_ID_MAP was never actually
// used here. Expanded to use that full map plus the standard forex majors
// Twelve Data's free /quote endpoint already accepts in the same "EUR/USD"
// shape. `band` groups these for the client's ticker rows (Market screen).
// Commodities are deliberately not expanded further — Twelve Data's free
// tier is the likely reason XAU/USD and WTI/USD return no quote live today
// (commodity data is typically a paid-plan feature there); adding more
// commodity symbols wouldn't fix that, a plan decision would.
const SHARED_WATCHLIST = [
    { symbol: 'BTC', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'ETH', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'SOL', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'XRP', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'DOGE', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'ADA', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'BNB', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'LTC', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'MATIC', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'DOT', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'AVAX', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'LINK', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'ATOM', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'SHIB', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'UNI', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'NEAR', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'SUI', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'APT', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'ARB', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'OP', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'FIL', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'ICP', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'XLM', assetClass: 'crypto', band: 'crypto' },
    { symbol: 'ALGO', assetClass: 'crypto', band: 'crypto' },

    { symbol: 'EUR/USD', assetClass: 'forex', band: 'forex' },
    { symbol: 'GBP/USD', assetClass: 'forex', band: 'forex' },
    { symbol: 'USD/JPY', assetClass: 'forex', band: 'forex' },
    { symbol: 'USD/CHF', assetClass: 'forex', band: 'forex' },
    { symbol: 'AUD/USD', assetClass: 'forex', band: 'forex' },
    { symbol: 'USD/CAD', assetClass: 'forex', band: 'forex' },
    { symbol: 'NZD/USD', assetClass: 'forex', band: 'forex' },
    { symbol: 'EUR/GBP', assetClass: 'forex', band: 'forex' },
    { symbol: 'EUR/JPY', assetClass: 'forex', band: 'forex' },
    { symbol: 'USD/ZAR', assetClass: 'forex', band: 'forex' },
    { symbol: 'USD/INR', assetClass: 'forex', band: 'forex' },
    { symbol: 'USD/NGN', assetClass: 'forex', band: 'forex' },

    { symbol: 'AAPL', assetClass: 'stock', band: 'tickers' },
    { symbol: 'MSFT', assetClass: 'stock', band: 'tickers' },
    { symbol: 'GOOGL', assetClass: 'stock', band: 'tickers' },
    { symbol: 'AMZN', assetClass: 'stock', band: 'tickers' },
    { symbol: 'TSLA', assetClass: 'stock', band: 'tickers' },
    { symbol: 'NVDA', assetClass: 'stock', band: 'tickers' },
    { symbol: 'XAU/USD', assetClass: 'commodity', band: 'tickers' },
    { symbol: 'XAG/USD', assetClass: 'commodity', band: 'tickers' },
    { symbol: 'WTI/USD', assetClass: 'commodity', band: 'tickers' }
];

router.get('/watchlist', async (_req: Request, res: Response) => {
    try {
        const quotes = await Promise.all(
            SHARED_WATCHLIST.map(async ({ symbol, assetClass, band }) => ({
                ...(await getQuote(symbol, assetClass)),
                symbol, assetClass, band
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
        const { symbol, assetClass, interval } = req.query;
        if (!symbol || !assetClass) {
            return res.status(200).json({ success: false, candles: [], error: 'symbol and assetClass are required' });
        }
        const candles = await getCandles(String(symbol), String(assetClass), interval ? String(interval) : '1day');
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
