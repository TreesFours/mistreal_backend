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
            if (!id) return null;
            const resp = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
                params: { ids: id, vs_currencies: 'usd', include_24hr_change: 'true' },
                timeout: 8000
            });
            const data = resp.data?.[id];
            if (!data) return null;
            return { symbol: symbol.toUpperCase(), price: data.usd, currency: 'USD', changePercent: data.usd_24h_change ?? null };
        }

        // stock | commodity
        const apiKey = process.env.TWELVE_DATA_API_KEY;
        if (!apiKey) return null;
        const resp = await axios.get('https://api.twelvedata.com/quote', {
            params: { symbol, apikey: apiKey },
            timeout: 8000
        });
        if (resp.data?.status === 'error' || !resp.data?.close) return null;
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
