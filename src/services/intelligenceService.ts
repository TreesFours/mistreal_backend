import axios from 'axios';
import { Op } from 'sequelize';
import logger from '../utils/logger';
import { IntelligenceBuffer, User, SocialEvent } from '../models/userModel';
import { PinnedIntel } from '../models/PinnedIntel';
import { getWeatherData } from './weatherService';
import { getDetailedAstroData, getNasaApod, getSpaceNews } from './astroService';
import { getLiveDisasters } from './disasterService';

/**
 * 🛰️ STRATEGIC INTELLIGENCE SERVICE
 * Implements the "Rolling 15 Flow", "Interleaved Rhythm", and "Proactive Weather" logic.
 */
export class IntelligenceService {

    /**
     * Returns the consolidated feed for the app with a specific "Rhythm".
     * 🕒 1 News -> 1 Novel -> 1 Astro -> 1 Social
     */
    static async getInterleavedFeed(firebaseUid: string, fastLoad: boolean = false) {
        try {
            // 1. Fetch User & Device Context
            const user = await User.findOne({ where: { firebaseUid } });
            const deviceId = user?.deviceId;

            // 2. Fetch All Intelligence Buffers (including disasters & markets)
            const [newsBuffer, novelBuffer, wikiBuffer, journalBuffer, astroBuffer, sportsBuffer, disasterBuffer, marketBuffer] = await Promise.all([
                IntelligenceBuffer.findOne({ where: { category: 'news' } }),
                IntelligenceBuffer.findOne({ where: { category: 'novels' } }),
                IntelligenceBuffer.findOne({ where: { category: 'wiki' } }),
                IntelligenceBuffer.findOne({ where: { category: 'journals' } }),
                IntelligenceBuffer.findOne({ where: { category: 'astro' } }),
                IntelligenceBuffer.findOne({ where: { category: 'sports' } }),
                IntelligenceBuffer.findOne({ where: { category: 'disasters' } }),
                IntelligenceBuffer.findOne({ where: { category: 'markets' } })
            ]);

            // 3. Fetch Social Events (only if deviceId is known)
            let socialItems: any[] = [];
            if (deviceId) {
                const events = await SocialEvent.findAll({
                    where: { deviceId },
                    order: [['timestamp', 'DESC']],
                    limit: 15
                });
                socialItems = events.map((e: any) => ({
                    title: `[Social] ${e.senderName}`,
                    description: e.content,
                    url: `mistreal://chat?platform=${e.platform}&targetId=${e.senderId}`,
                    source: e.platform,
                    timestamp: e.timestamp,
                    type: 'social'
                }));
            }

            // 4. Fetch Pinned Intel
            const pinned = await PinnedIntel.findAll({ where: { firebaseUid } });
            const pinnedTitles = pinned.map((p: any) => p.itemTitle);

            // 5. Prepare Categories (Filtering out pinned items so they don't appear twice)
            const limit = fastLoad ? 10 : 25;
            const news = (newsBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, limit);
            const novels = (novelBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, 5);
            const wikis = (wikiBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, 5);
            const journals = (journalBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, 5);
            const astro = (astroBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, limit);
            const socials = socialItems.filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, limit);
            const sports = (sportsBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, 15);
            const disasters = (disasterBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).map((d: any) => ({ ...d, type: 'sos_alert' }));
            const markets = (marketBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).map((m: any) => ({ ...m, type: 'news' }));

            // 6. Interleave Logic (The Rhythm)
            const interleaved: any[] = [];

            // Add Novel, Wiki, Journal, Sports at the very top (Horizontal sections in UI)
            const horizontalIntel = [
                ...novels.map((n: any) => ({ ...n, type: 'novel' })),
                ...wikis.map((w: any) => ({ ...w, type: 'wiki' })),
                ...journals.map((j: any) => ({ ...j, type: 'journal' })),
                ...sports.map((s: any) => ({ ...s, type: 'sports' }))
            ];

            const maxLength = Math.max(news.length, astro.length, socials.length, disasters.length, markets.length);

            for (let i = 0; i < maxLength; i++) {
                if (disasters[i]) interleaved.push(disasters[i]);
                if (news[i]) interleaved.push({ ...news[i], type: 'news' });
                if (markets[i]) interleaved.push(markets[i]);
                if (astro[i]) interleaved.push({ ...astro[i], type: 'astro' });
                if (socials[i]) interleaved.push(socials[i]);
            }

            // 7. Add Pinned items to the very top
            const finalPinned = pinned.map((p: any) => ({
                title: p.itemTitle,
                url: p.itemUrl,
                type: p.itemType,
                ...p.metadata,
                isPinned: true
            }));

            return [...finalPinned, ...horizontalIntel, ...interleaved];
        } catch (e: any) {
            logger.error(`❌ Interleaved Feed Error: ${e.message}`);
            return [];
        }
    }

    /**
     * Updates a specific intelligence category buffer.
     * Capped at 15 items, newest first, AND age-pruned.
     */
    private static async updateBuffer(category: string, newItems: any[], maxAgeDays: number = 1) {
        try {
            const [buffer] = await IntelligenceBuffer.findOrCreate({
                where: { category },
                defaults: { category, items: [] }
            });

            const currentItems = buffer.items || [];
            const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
            const freshItems = currentItems.filter((item: any) => {
                const t = new Date(item.timestamp).getTime();
                return !isNaN(t) && t >= cutoff;
            });

            // Add new items, filtering out duplicates by title
            const uniqueNewItems = newItems.filter((newItem: any) =>
                !freshItems.some((existing: any) => existing.title === newItem.title)
            );

            if (uniqueNewItems.length === 0 && freshItems.length === currentItems.length) {
                buffer.lastUpdated = new Date();
                await buffer.save();
                return;
            }

            // Prepend new items and truncate to 15
            const updatedItems = [...uniqueNewItems, ...freshItems].slice(0, 15);

            buffer.items = updatedItems;
            buffer.lastUpdated = new Date();
            await buffer.save();

            logger.info(`🔄 [Intel] Buffer updated: ${category} (+${uniqueNewItems.length} items, -${currentItems.length - freshItems.length} stale)`);
        } catch (e: any) {
            logger.error(`❌ Buffer Update Error (${category}): ${e.message}`);
        }
    }

    /**
     * Wholesale-replaces a buffer's items (vs. updateBuffer's append-and-dedupe-by-
     * title) — for categories like sports where the SAME title needs its content
     * (the score) refreshed each cycle, not treated as already-seen and skipped.
     */
    private static async replaceBuffer(category: string, newItems: any[]) {
        try {
            const [buffer] = await IntelligenceBuffer.findOrCreate({
                where: { category },
                defaults: { category, items: [] }
            });
            buffer.items = newItems.slice(0, 30);
            buffer.lastUpdated = new Date();
            await buffer.save();
        } catch (e: any) {
            logger.error(`❌ Buffer Replace Error (${category}): ${e.message}`);
        }
    }

    /**
     * GLOBAL ROLLING ENGINE
     * Triggered by cron or background worker.
     */
    static async refreshGlobalIntel() {
        logger.info('🚀 Starting Global Intelligence Refresh...');

        await Promise.all([
            this.refreshNews(),
            this.refreshAstro(),
            this.refreshLiterature(),
            this.refreshWiki(),
            this.refreshJournals(),
            this.refreshSports(),
            this.refreshDisasters()
        ]);
    }

    /**
     * 🌋 LIVE GLOBAL DISASTERS & HAZARDS (USGS Earthquakes + GDACS Hazards)
     */
    static async refreshDisasters() {
        try {
            const disasters = await getLiveDisasters();
            const items = disasters.map(d => ({
                title: d.title,
                description: `${d.severity} ${d.type.toUpperCase()} · Location: ${d.locationName}${d.magnitude ? ` · M${d.magnitude}` : ''}`,
                url: d.url,
                source: d.type === 'earthquake' ? 'USGS Earthquake Science' : 'GDACS Disaster Alert',
                category: d.type,
                timestamp: d.timestamp,
                metadata: {
                    latitude: d.latitude,
                    longitude: d.longitude,
                    severity: d.severity,
                    disasterType: d.type,
                    magnitude: d.magnitude
                }
            }));
            if (items.length > 0) {
                await this.replaceBuffer('disasters', items);
                logger.info(`🌋 [Disasters] Buffer updated: ${items.length} hazard alerts`);
            }
        } catch (e: any) {
            logger.warn(`⚠️ [Disasters] Refresh Warning: ${e.message}`);
        }
    }

    /**
     * 🏆 LIVE-ISH SPORTS SCORES — free tier, no API key required (uses
     * TheSportsDB's public test key). Scheduled separately from the hourly
     * refreshGlobalIntel cadence since scores go stale much faster than news.
     *
     * HONEST LIMITATION: TheSportsDB's free tier serves fixtures/results for
     * the day, not a true sub-minute live in-play feed — that requires their
     * paid Patreon tier (or a different provider like API-Football). This is
     * "refreshed every few minutes," not "updates mid-play." If genuinely
     * live in-play scores matter, that's a provider upgrade decision, not a
     * code change.
     */
    static async refreshSports() {
        try {
            const apiKey = process.env.SPORTSDB_API_KEY || '3'; // '3' = TheSportsDB's public test key
            const today = new Date().toISOString().split('T')[0];
            const sports = ['Soccer', 'Basketball', 'American_Football', 'Baseball', 'Ice_Hockey'];

            const results = await Promise.allSettled(
                sports.map(sport =>
                    axios.get(`https://www.thesportsdb.com/api/v1/json/${apiKey}/eventsday.php`, {
                        params: { d: today, s: sport },
                        timeout: 8000
                    })
                )
            );

            const allEvents: any[] = [];
            results.forEach((res, index) => {
                if (res.status === 'fulfilled' && res.value.data?.events) {
                    allEvents.push(...res.value.data.events.map((e: any) => ({ ...e, _sport: sports[index].replace('_', ' ') })));
                } else if (res.status === 'rejected') {
                    logger.warn(`⚠️ Sports fetch warning [${sports[index]}]: ${(res.reason as any)?.message}`);
                }
            });

            if (allEvents.length === 0) return;

            const items = allEvents.slice(0, 30).map((e: any) => {
                const hasScore = e.intHomeScore !== null && e.intHomeScore !== undefined && e.intAwayScore !== null && e.intAwayScore !== undefined;
                const scoreLine = hasScore ? `${e.intHomeScore} - ${e.intAwayScore}` : (e.strTime ? `Kickoff ${e.strTime}` : 'Scheduled');
                return {
                    title: `[${e._sport}] ${e.strHomeTeam} vs ${e.strAwayTeam}`,
                    description: `${scoreLine} · ${e.strLeague || ''} · ${e.strStatus || 'Scheduled'}`,
                    url: e.strVideo || `https://www.thesportsdb.com/event/${e.idEvent}`,
                    source: 'TheSportsDB',
                    category: e._sport,
                    timestamp: `${e.dateEvent}T${(e.strTime || '00:00:00')}`
                };
            });

            // Sports needs REPLACE semantics, not updateBuffer's append-and-dedupe-by-
            // title — the whole point is the same match's score changing over time,
            // and a title-based dedupe would treat a re-fetched fixture as a
            // duplicate and silently drop the updated score.
            await this.replaceBuffer('sports', items);
            logger.info(`🏆 [Sports] Buffer updated: ${items.length} fixtures across ${sports.length} sports`);
        } catch (e: any) {
            logger.warn(`⚠️ Sports refresh warning: ${e.message}`);
        }
    }

    private static async refreshNews() {
        const apiKey = process.env.NEWS_API_KEY;
        const allArticles: any[] = [];

        // 🏙️ Step 1: Hyper-Local City News via Google News RSS (Keyless, 100% Free)
        try {
            const activeUser = await User.findOne({
                where: { lastKnownCity: { [Op.ne]: null } },
                order: [['lastLocationUpdate', 'DESC']]
            });
            const city = activeUser?.lastKnownCity || 'World';
            const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(city)}&hl=en-US&gl=US&ceid=US:en`;

            const rssResponse = await axios.get(rssUrl, { timeout: 8000 });
            const xml = rssResponse.data || '';
            const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

            items.slice(0, 10).forEach((itemXml: string) => {
                const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/);
                const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/);
                const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
                const sourceMatch = itemXml.match(/<source[\s\S]*?>([\s\S]*?)<\/source>/);

                if (titleMatch && linkMatch) {
                    const rawTitle = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
                    const link = linkMatch[1].trim();
                    const source = sourceMatch ? sourceMatch[1].trim() : 'Google News';
                    const pubDate = pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString();

                    allArticles.push({
                        title: `[${city}] ${rawTitle}`,
                        description: `Local news report for ${city} via ${source}.`,
                        url: link,
                        imageUrl: null,
                        source,
                        category: 'local',
                        timestamp: pubDate
                    });
                }
            });
        } catch (e: any) {
            logger.warn(`⚠️ Google News RSS fetch warning: ${e.message}`);
        }

        // 🌍 Step 2: Global Headlines via NewsAPI if configured
        if (apiKey) {
            try {
                const categories = ['general', 'technology', 'science'];
                const results = await Promise.allSettled(
                    categories.map(cat =>
                        axios.get(`https://newsapi.org/v2/top-headlines`, {
                            params: { category: cat, country: 'us', apiKey },
                            timeout: 8000
                        })
                    )
                );

                results.forEach((res, index) => {
                    if (res.status === 'fulfilled' && res.value.data?.articles) {
                        const cat = categories[index];
                        const mapped = res.value.data.articles.map((a: any) => ({
                            title: a.title,
                            description: a.description || 'No description available.',
                            url: a.url,
                            imageUrl: a.urlToImage || null,
                            source: a.source?.name || 'News',
                            category: cat,
                            timestamp: a.publishedAt || new Date().toISOString()
                        }));
                        allArticles.push(...mapped);
                    }
                });
            } catch (e: any) {
                logger.warn(`⚠️ NewsAPI fetch warning: ${e.message}`);
            }
        }

        // Fallback default news if all lookups yielded 0 articles
        if (allArticles.length === 0) {
            logger.info('📌 Injecting fallback default news articles into Intelligence Buffer.');
            allArticles.push(
                {
                    title: "[Intelligence] Neural Link Architecture Deployed Globally",
                    description: "Next-generation distributed agent networks achieve sub-millisecond synchronization across mobile nodes.",
                    url: "https://mistreal.ai/intel/neural-link",
                    source: "Mistreal Intelligence",
                    category: "technology",
                    timestamp: new Date().toISOString()
                },
                {
                    title: "[Intelligence] Quantum Encryption Standards Upgraded",
                    description: "New cryptographic protocols ensure zero leakage across multi-tenant social connectors and agent bridges.",
                    url: "https://mistreal.ai/intel/quantum-security",
                    source: "Mistreal Security",
                    category: "science",
                    timestamp: new Date().toISOString()
                }
            );
        }

        await this.updateBuffer('news', allArticles);
    }

    private static async refreshAstro() {
        try {
            const astroItems: any[] = [];

            // 1. Fetch NASA Picture of the Day (APOD)
            const apod = await getNasaApod();
            if (apod) {
                astroItems.push({
                    title: `[NASA APOD] ${apod.title}`,
                    description: apod.explanation.length > 250 ? apod.explanation.substring(0, 247) + '...' : apod.explanation,
                    url: apod.hdurl || apod.url,
                    imageUrl: apod.mediaType === 'image' ? apod.url : null,
                    source: 'NASA APOD',
                    timestamp: new Date().toISOString(),
                    metadata: { apodDate: apod.date, mediaType: apod.mediaType }
                });
            }

            // 2. Fetch Live Spaceflight & Orbital News
            const spaceNews = await getSpaceNews();
            spaceNews.slice(0, 5).forEach(a => {
                astroItems.push({
                    title: `[Spaceflight] ${a.title}`,
                    description: a.summary.length > 250 ? a.summary.substring(0, 247) + '...' : a.summary,
                    url: a.url,
                    imageUrl: a.imageUrl || null,
                    source: a.newsSite || 'Spaceflight News',
                    timestamp: a.publishedAt || new Date().toISOString()
                });
            });

            // 3. Moon & Planetary Vectors
            const data = await getDetailedAstroData(0, 0);
            if (data) {
                astroItems.push({
                    title: `[Astro] ${data.moon.phase} phase`,
                    description: `Current Moon state: ${data.moon.phase}. ${data.summary}`,
                    url: data.moon.imageUrl || "https://api.astronomyapi.com",
                    source: 'Astronomy Intelligence',
                    timestamp: new Date().toISOString(),
                    metadata: {
                        moonPhase: data.moon.phase,
                        planets: data.planets.filter((p: any) => p.isVisible).map((p: any) => p.name).join(', ')
                    }
                });
            }

            if (astroItems.length > 0) {
                await this.updateBuffer('astro', astroItems);
            }
        } catch (e: any) {
            logger.warn(`⚠️ [Intel] refreshAstro failed: ${e.message}`);
        }
    }

    private static async refreshWiki() {
        try {
            const [buffer] = await IntelligenceBuffer.findOrCreate({
                where: { category: 'wiki' },
                defaults: { category: 'wiki', items: [] }
            });

            const lastUpdatedDate = new Date(buffer.lastUpdated).toDateString();
            const todayDate = new Date().toDateString();

            if (lastUpdatedDate === todayDate && (buffer.items || []).length >= 3) return;

            const articles: any[] = [];
            for (let i = 0; i < 3; i++) {
                try {
                    const response = await axios.get('https://en.wikipedia.org/api/rest_v1/page/random/summary', { timeout: 5000 });
                    if (response.data && response.data.title) {
                        articles.push({
                            title: `[Wiki] ${response.data.title}`,
                            description: response.data.extract || 'Wikipedia summary',
                            url: response.data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(response.data.title)}`,
                            imageUrl: response.data.thumbnail?.source || null,
                            source: 'Wikipedia',
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (err) {}
            }

            if (articles.length > 0) {
                await this.updateBuffer('wiki', articles, 5);
            }
        } catch (e: any) {
            logger.warn(`⚠️ [Intel] refreshWiki failed: ${e.message}`);
        }
    }

    private static async refreshJournals() {
        try {
            // Live ArXiv API XML Query for AI, Physics, and Biology papers
            const arxivUrl = 'https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:physics.gen-ph+OR+cat:q-bio&start=0&max_results=8&sortBy=submittedDate&sortOrder=descending';
            const response = await axios.get(arxivUrl, { timeout: 10000 });
            const xml = response.data || '';
            const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

            const journals: any[] = [];
            entries.forEach((entryXml: string) => {
                const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/);
                const summaryMatch = entryXml.match(/<summary>([\s\S]*?)<\/summary>/);
                const idMatch = entryXml.match(/<id>([\s\S]*?)<\/id>/);
                const publishedMatch = entryXml.match(/<published>([\s\S]*?)<\/published>/);

                if (titleMatch && idMatch) {
                    const title = titleMatch[1].replace(/\n/g, ' ').trim();
                    const summary = summaryMatch ? summaryMatch[1].replace(/\n/g, ' ').trim() : 'ArXiv research paper.';
                    const url = idMatch[1].trim();
                    const pubDate = publishedMatch ? new Date(publishedMatch[1].trim()).toISOString() : new Date().toISOString();

                    journals.push({
                        title: `[Journal] ${title}`,
                        description: summary.length > 250 ? summary.substring(0, 247) + '...' : summary,
                        url,
                        source: 'ArXiv Research',
                        timestamp: pubDate
                    });
                }
            });

            if (journals.length > 0) {
                await this.updateBuffer('journals', journals, 7);
            }
        } catch (e: any) {
            logger.warn(`⚠️ [Intel] refreshJournals failed: ${e.message}`);
        }
    }

    private static async getReadableBookUrl(workKey: string): Promise<string> {
        const catalogUrl = `https://openlibrary.org${workKey}`;
        try {
            const editionsResp = await axios.get(`https://openlibrary.org${workKey}/editions.json`, { timeout: 5000 });
            const editions = editionsResp.data?.entries || [];
            const readable = editions.find((e: any) => e.ocaid);
            return readable ? `https://archive.org/details/${readable.ocaid}` : catalogUrl;
        } catch (e: any) {
            return catalogUrl;
        }
    }

    private static async refreshLiterature() {
        try {
            // Dynamic Subject Rotation (scifi, fantasy, mystery, history, tech, etc.) with random offset
            const subjects = ['science_fiction', 'fantasy', 'mystery', 'history', 'technology', 'thriller', 'biography', 'adventure', 'classics', 'philosophy'];
            const randomSubject = subjects[Math.floor(Math.random() * subjects.length)];
            const randomOffset = Math.floor(Math.random() * 15);

            const response = await axios.get(`https://openlibrary.org/subjects/${randomSubject}.json`, {
                params: { limit: 8, offset: randomOffset },
                timeout: 10000
            });
            const works = response.data?.works || [];
            const novels = await Promise.all(works.slice(0, 8).map(async (w: any) => {
                const authors = (w.authors || []).map((a: any) => a.name).join(', ') || 'Unknown Author';
                return {
                    title: `[Novel] ${w.title}`,
                    description: `Author: ${authors}. Subject: ${randomSubject.replace('_', ' ')}.`,
                    url: await this.getReadableBookUrl(w.key),
                    imageUrl: w.cover_id ? `https://covers.openlibrary.org/b/id/${w.cover_id}-M.jpg` : null,
                    source: 'OpenLibrary',
                    timestamp: new Date().toISOString()
                };
            }));

            if (novels.length > 0) {
                await this.updateBuffer('novels', novels, 7);
            }
        } catch (e: any) {
            logger.warn(`⚠️ [Intel] refreshLiterature failed: ${e.message}`);
        }
    }

    /**
     * PROACTIVE WEATHER ENGINE
     */
    static async refreshProactiveWeather() {
        logger.info('🌦️ Refreshing proactive weather for active users...');
        const activeUsers = await User.findAll({
            where: {
                lastKnownLat: { [Op.ne]: null }
            }
        });

        for (const user of activeUsers) {
            if (user.lastKnownLat && user.lastKnownLon) {
                try {
                    const weather = await getWeatherData(user.lastKnownLat, user.lastKnownLon);
                    user.lastWeatherSummary = weather.summary;
                    user.lastKnownCity = weather.location;
                    if (weather.country) user.lastKnownCountry = weather.country;
                    user.lastLocationUpdate = new Date();
                    await user.save();
                } catch (e: any) {
                    logger.warn(`⚠️ [Intel] refreshProactiveWeather failed for device ${user.deviceId}: ${e.message}`);
                }
            }
        }
    }

    /**
     * Legacy Global Feed (kept for compatibility)
     */
    static async getGlobalFeed() {
        const buffers = await IntelligenceBuffer.findAll();
        let allItems: any[] = [];
        buffers.forEach((buffer: any) => {
            allItems = [...allItems, ...(buffer.items || [])];
        });
        return allItems.sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
}
