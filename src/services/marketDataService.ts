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
    MATIC: 'polygon', DOT: 'polkadot', AVAX: 'avalanche-2', LINK: 'chainlink',
    ATOM: 'cosmos', SHIB: 'shiba-inu', UNI: 'uniswap', NEAR: 'near',
    SUI: 'sui', APT: 'aptos', FET: 'artificial-superintelligence-alliance', RENDER: 'render-token',
    PEPE: 'pepe', ARB: 'arbitrum', OP: 'optimism', FIL: 'filecoin',
    ICP: 'internet-computer', TIA: 'celestia', INJ: 'injective-protocol', STX: 'blockstack',
    KAS: 'kaspa', RUNE: 'thorchain', XLM: 'stellar', ALGO: 'algorand'
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

// Quotes had no caching at all — every single /watchlist request fired one
// fresh provider call per symbol, from every user, with no sharing between
// them. Harmless at the original 4-crypto/8-non-crypto size, but expanding
// the watchlist to a real comprehensive list without this would mean 20+
// simultaneous Twelve Data calls per request against a free-tier rate limit
// that's typically far tighter than that (commonly ~8/minute) — this short
// TTL means concurrent/rapid requests across all users share one real fetch
// per symbol instead of each paying for their own.
const QUOTE_CACHE_TTL_MS = 30_000;
const quoteCache = new Map<string, { fetchedAt: number; quote: Quote | null }>();

/**
 * Live quote for one symbol — dispatches to Twelve Data (stocks/commodities)
 * or CoinGecko (crypto) depending on assetClass. Returns null on any failure
 * (missing key, unknown symbol, provider error) — callers must treat that as
 * "unavailable right now," never as a price of zero.
 */
// coingeckoId lets a caller quote a crypto symbol that isn't in the
// hand-curated COINGECKO_ID_MAP at all — search() below resolves the real id
// from CoinGecko's own search endpoint for exactly this, so "all tickers,
// searchable" doesn't require hand-adding every coin to the map first.
export const getQuote = async (symbol: string, assetClass: string, coingeckoId?: string): Promise<Quote | null> => {
    const cacheKey = `${assetClass}:${symbol}`;
    const cached = quoteCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < QUOTE_CACHE_TTL_MS) return cached.quote;

    const quote = await fetchQuoteUncached(symbol, assetClass, coingeckoId);
    quoteCache.set(cacheKey, { fetchedAt: Date.now(), quote });
    return quote;
};

const fetchQuoteUncached = async (symbol: string, assetClass: string, coingeckoId?: string): Promise<Quote | null> => {
    try {
        if (assetClass === 'crypto') {
            const id = coingeckoId || COINGECKO_ID_MAP[symbol.toUpperCase()];
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
export const getCandles = async (symbol: string, assetClass: string, interval: string = '1day', coingeckoId?: string): Promise<Candle[] | null> => {
    // interval is now part of the cache key — a 1h and a 1day fetch for the
    // same symbol used to collide under the old assetClass:symbol-only key,
    // silently serving whichever granularity happened to be cached first.
    const cacheKey = `${assetClass}:${symbol}:${interval}`;
    const today = new Date().toISOString().split('T')[0];
    const cached = candleCache.get(cacheKey);
    if (cached && cached.date === today) return cached.candles;

    try {
        let candles: Candle[] | null = null;

        if (assetClass === 'crypto') {
            // CoinGecko's free /ohlc tier has no hourly granularity to
            // request — confirmed, not assumed. Crypto always gets the
            // existing daily series regardless of the requested interval;
            // the client is expected to not offer 1h/4h chips for crypto at
            // all (gated in MarketAlertsSection.kt) rather than round-trip
            // to find this out.
            const id = coingeckoId || COINGECKO_ID_MAP[symbol.toUpperCase()];
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
            // Twelve Data supports intraday intervals ('1h'/'4h') on this
            // same endpoint — intraday requests use a smaller outputsize
            // since 180 hourly/4h bars is plenty of chart history and
            // keeps the response light.
            const isIntraday = interval !== '1day';
            const resp = await axios.get('https://api.twelvedata.com/time_series', {
                params: { symbol, interval, outputsize: isIntraday ? 90 : 180, apikey: apiKey },
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

export interface SymbolSearchResult {
    symbol: string;
    name: string;
    assetClass: string;
    // Only ever set for crypto — the real CoinGecko id, so a result not in
    // COINGECKO_ID_MAP is still quotable immediately (see getQuote/getCandles
    // above), without needing it hand-added to the map first.
    coingeckoId?: string;
}

// "All tickers, searchable" without proactively polling hundreds of symbols
// (which would blow through Twelve Data's free-tier rate limit fast) — this
// only ever runs on an explicit user search, each result quoted on-demand
// afterward through the existing cached getQuote/getCandles, same as every
// symbol already in SHARED_WATCHLIST.
export const searchSymbols = async (query: string): Promise<SymbolSearchResult[]> => {
    const results: SymbolSearchResult[] = [];

    try {
        const cgResp = await axios.get('https://api.coingecko.com/api/v3/search', {
            params: { query }, timeout: 8000
        });
        (cgResp.data?.coins || []).slice(0, 10).forEach((c: any) => {
            results.push({ symbol: (c.symbol || '').toUpperCase(), name: c.name, assetClass: 'crypto', coingeckoId: c.id });
        });
    } catch (e: any) {
        logger.warn(`⚠️ [Markets] CoinGecko search warning: ${e.message}`);
    }

    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (apiKey) {
        try {
            const tdResp = await axios.get('https://api.twelvedata.com/symbol_search', {
                params: { symbol: query, apikey: apiKey }, timeout: 8000
            });
            (tdResp.data?.data || []).slice(0, 10).forEach((s: any) => {
                // instrument_type distinguishes "Common Stock" from
                // forex/ETF/etc — only stock-shaped results are mapped to
                // 'stock' here; everything else Twelve Data could return
                // (ETF, index) is skipped rather than mis-tagged into a
                // chart path (forex/commodity) that expects a different
                // symbol shape ("EUR/USD", not "XYZ").
                if (s.instrument_type === 'Common Stock') {
                    results.push({ symbol: s.symbol, name: s.instrument_name, assetClass: 'stock' });
                }
            });
        } catch (e: any) {
            logger.warn(`⚠️ [Markets] Twelve Data symbol_search warning: ${e.message}`);
        }
    }

    return results;
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
