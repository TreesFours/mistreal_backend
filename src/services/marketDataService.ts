import axios from 'axios';
import logger from '../utils/logger';
import { MarketAlert } from '../models/MarketAlert';

// CoinGecko's price endpoint needs its own "id" slug, not a ticker — this is a
// small, expandable, hand-curated map covering common coins. A symbol not in
// here simply can't be quoted yet (fails soft, same pattern as everything
// else optional in this service), rather than guessing wrong.
const COINGECKO_ID_MAP: Record<string, string> = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', DOGE: 'dogecoin',
    XRP: 'ripple', ADA: 'cardano', BNB: 'binancecoin', LTC: 'litecoin',
    MATIC: 'polygon', DOT: 'polkadot', AVAX: 'avalanche-2', LINK: 'chainlink'
};

export interface Quote {
    symbol: string;
    price: number;
    currency: string;
    changePercent: number | null;
}

export interface Candle {
    timestamp: number; // epoch ms
    open: number;
    high: number;
    low: number;
    close: number;
}

// Daily candles don't change until the next day's close — cache in memory per
// symbol+day so reopening the same chart later the same day costs nothing,
// and a crowded day doesn't multiply calls to either provider's free tier.
const candleCache = new Map<string, { date: string; candles: Candle[] }>();

/**
 * Live quote for one symbol — dispatches to Twelve Data (stocks/commodities)
 * or CoinGecko (crypto) depending on assetClass. Returns null on any failure
 * (missing key, unknown symbol, provider error) — callers must treat that as
 * "unavailable right now," never as a price of zero.
 */
export const getQuote = async (symbol: string, assetClass: string): Promise<Quote | null> => {
    try {
        if (assetClass === 'crypto') {
            const id = COINGECKO_ID_MAP[symbol.toUpperCase()];
            if (!id) {
                logger.warn(`⚠️ [Markets] getQuote: no CoinGecko id mapped for crypto symbol "${symbol}" — add it to COINGECKO_ID_MAP`);
                return null;
            }
            const resp = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
                params: { ids: id, vs_currencies: 'usd', include_24hr_change: 'true' },
                timeout: 8000
            });
            const data = resp.data?.[id];
            if (!data) {
                logger.warn(`⚠️ [Markets] getQuote: CoinGecko returned no data for ${symbol} (id=${id})`);
                return null;
            }
            return { symbol: symbol.toUpperCase(), price: data.usd, currency: 'USD', changePercent: data.usd_24h_change ?? null };
        }

        // stock | commodity
        const apiKey = process.env.TWELVE_DATA_API_KEY;
        if (!apiKey) {
            logger.warn(`⚠️ [Markets] getQuote(${symbol}): TWELVE_DATA_API_KEY not set — stock/commodity quotes will all return empty until it's configured`);
            return null;
        }
        const resp = await axios.get('https://api.twelvedata.com/quote', {
            params: { symbol, apikey: apiKey },
            timeout: 8000
        });
        if (resp.data?.status === 'error' || !resp.data?.close) {
            logger.warn(`⚠️ [Markets] getQuote(${symbol}): Twelve Data returned no usable quote — ${JSON.stringify(resp.data).slice(0, 200)}`);
            return null;
        }
        return {
            symbol: symbol.toUpperCase(),
            price: parseFloat(resp.data.close),
            currency: resp.data.currency || 'USD',
            changePercent: resp.data.percent_change ? parseFloat(resp.data.percent_change) : null
        };
    } catch (e: any) {
        logger.warn(`⚠️ [Markets] Quote fetch failed for ${symbol} (${assetClass}): ${e.message}`);
        return null;
    }
};

/**
 * ~6 months of daily candles (180 for crypto/commodities which can trade
 * weekends; up to ~130 trading days for stocks) — deliberately capped, never
 * more, per the "keep it minimal, not heavy on the phone" brief. Same
 * normalized shape regardless of which provider actually served it, so the
 * client's chart component never needs to know the difference.
 */
export const getCandles = async (symbol: string, assetClass: string): Promise<Candle[] | null> => {
    const cacheKey = `${assetClass}:${symbol}`;
    const today = new Date().toISOString().split('T')[0];
    const cached = candleCache.get(cacheKey);
    if (cached && cached.date === today) return cached.candles;

    try {
        let candles: Candle[] | null = null;

        if (assetClass === 'crypto') {
            const id = COINGECKO_ID_MAP[symbol.toUpperCase()];
            if (!id) {
                logger.warn(`⚠️ [Markets] getCandles: no CoinGecko id mapped for crypto symbol "${symbol}"`);
                return null;
            }
            const resp = await axios.get(`https://api.coingecko.com/api/v3/coins/${id}/ohlc`, {
                params: { vs_currency: 'usd', days: 180 },
                timeout: 10000
            });
            // CoinGecko returns bare arrays: [timestamp_ms, open, high, low, close]
            candles = (resp.data || []).map((row: number[]) => ({
                timestamp: row[0], open: row[1], high: row[2], low: row[3], close: row[4]
            }));
        } else {
            const apiKey = process.env.TWELVE_DATA_API_KEY;
            if (!apiKey) {
                logger.warn(`⚠️ [Markets] getCandles(${symbol}): TWELVE_DATA_API_KEY not set`);
                return null;
            }
            const resp = await axios.get('https://api.twelvedata.com/time_series', {
                params: { symbol, interval: '1day', outputsize: 180, apikey: apiKey },
                timeout: 10000
            });
            if (resp.data?.status === 'error' || !Array.isArray(resp.data?.values)) {
                logger.warn(`⚠️ [Markets] getCandles(${symbol}): Twelve Data returned no usable series — ${JSON.stringify(resp.data).slice(0, 200)}`);
                return null;
            }
            candles = resp.data.values.map((v: any) => ({
                timestamp: new Date(v.datetime).getTime(),
                open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close)
            })).reverse(); // Twelve Data returns newest-first; chart wants oldest-first
        }

        if (candles && candles.length > 0) candleCache.set(cacheKey, { date: today, candles });
        return candles;
    } catch (e: any) {
        logger.warn(`⚠️ [Markets] Candle fetch failed for ${symbol} (${assetClass}): ${e.message}`);
        return null;
    }
};

/**
 * Checks every active, not-yet-triggered alert against a live quote, fetched
 * once per unique (symbol, assetClass) pair rather than once per alert — many
 * users watching the same symbol shouldn't multiply API calls.
 */
export const checkAlerts = async () => {
    const pending = await MarketAlert.findAll({ where: { active: true, triggeredAt: null } });
    if (pending.length === 0) return;

    const uniquePairs = new Map<string, { symbol: string; assetClass: string }>();
    pending.forEach(a => uniquePairs.set(`${a.assetClass}:${a.symbol}`, { symbol: a.symbol, assetClass: a.assetClass }));

    const quotes = new Map<string, Quote>();
    for (const { symbol, assetClass } of uniquePairs.values()) {
        const quote = await getQuote(symbol, assetClass);
        if (quote) quotes.set(`${assetClass}:${symbol}`, quote);
    }

    for (const alert of pending) {
        const quote = quotes.get(`${alert.assetClass}:${alert.symbol}`);
        if (!quote) continue;

        const crossed = alert.direction === 'above'
            ? quote.price >= alert.targetPrice
            : quote.price <= alert.targetPrice;

        if (crossed) {
            alert.triggeredAt = new Date();
            alert.triggeredPrice = quote.price;
            alert.active = false;
            await alert.save();
            logger.info(`🔔 [Markets] Alert triggered: ${alert.symbol} ${alert.direction} ${alert.targetPrice} (now ${quote.price})`);
        }
    }
};
