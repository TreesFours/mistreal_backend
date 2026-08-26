import axios from 'axios';
import { Op } from 'sequelize';
import logger from '../utils/logger';
import { IntelligenceBuffer, User, SocialEvent } from '../models/userModel';
import { PinnedIntel } from '../models/PinnedIntel';
import { getWeatherData } from './weatherService';

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

            // 2. Fetch All Intelligence Buffers
            const [newsBuffer, novelBuffer, astroBuffer] = await Promise.all([
                IntelligenceBuffer.findOne({ where: { category: 'news' } }),
                IntelligenceBuffer.findOne({ where: { category: 'novels' } }),
                IntelligenceBuffer.findOne({ where: { category: 'astro' } })
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
            const limit = fastLoad ? 3 : 15;
            const news = (newsBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, limit);
            const novels = (novelBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, limit);
            const astro = (astroBuffer?.items || []).filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, limit);
            const socials = socialItems.filter((i: any) => !pinnedTitles.includes(i.title)).slice(0, limit);

            // 6. Interleave Logic (The Rhythm)
            const interleaved: any[] = [];
            const maxLength = Math.max(news.length, novels.length, astro.length, socials.length);

            for (let i = 0; i < maxLength; i++) {
                if (news[i]) interleaved.push({ ...news[i], type: 'news' });
                if (novels[i]) interleaved.push({ ...novels[i], type: 'novel' });
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

            return [...finalPinned, ...interleaved];
        } catch (e: any) {
            logger.error(`❌ Interleaved Feed Error: ${e.message}`);
            return [];
        }
    }

    /**
     * Updates a specific intelligence category buffer.
     * Capped at 15 items. Newest first.
     */
    private static async updateBuffer(category: string, newItems: any[]) {
        try {
            const [buffer] = await IntelligenceBuffer.findOrCreate({
                where: { category },
                defaults: { category, items: [] }
            });

            const currentItems = buffer.items || [];

            // Add new items, filtering out duplicates by title
            const uniqueNewItems = newItems.filter((newItem: any) =>
                !currentItems.some((existing: any) => existing.title === newItem.title)
            );

            if (uniqueNewItems.length === 0) return;

            // Prepend new items and truncate to 15
            const updatedItems = [...uniqueNewItems, ...currentItems].slice(0, 15);

            buffer.items = updatedItems;
            buffer.lastUpdated = new Date();
            await buffer.save();

            logger.info(`🔄 [Intel] Buffer updated: ${category} (+${uniqueNewItems.length} items)`);
        } catch (e: any) {
            logger.error(`❌ Buffer Update Error (${category}): ${e.message}`);
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
            this.refreshEntertainment(),
            this.refreshAstro(),
            this.refreshLiterature()
        ]);
    }

    private static async refreshNews() {
        const apiKey = process.env.NEWS_API_KEY;
        if (!apiKey) return;

        try {
            const response = await axios.get(`https://newsapi.org/v2/top-headlines`, {
                params: { category: 'general', country: 'us', apiKey }
            });
            const articles = response.data.articles.map((a: any) => ({
                title: a.title,
                description: a.description,
                url: a.url,
                source: 'News',
                timestamp: a.publishedAt || new Date().toISOString()
            }));
            await this.updateBuffer('news', articles);
        } catch (e) {}
    }

    private static async refreshEntertainment() {
        const tmdbKey = process.env.TMDB_API_KEY;
        if (!tmdbKey) return;

        try {
            const response = await axios.get('https://api.themoviedb.org/3/movie/now_playing', {
                params: { api_key: tmdbKey }
            });
            const movies = response.data.results.map((m: any) => ({
                title: `[Movie] ${m.title}`,
                description: m.overview,
                url: `https://www.themoviedb.org/movie/${m.id}`,
                source: 'TMDB',
                timestamp: new Date().toISOString()
            }));
            await this.updateBuffer('entertainment', movies);
        } catch (e) {}
    }

    private static async refreshAstro() {
        const nasaKey = process.env.NASA_API_KEY;
        if (!nasaKey) return;

        try {
            const response = await axios.get('https://api.nasa.gov/planetary/apod', {
                params: { api_key: nasaKey }
            });
            const apod = [{
                title: `[Astro] ${response.data.title}`,
                description: response.data.explanation,
                url: response.data.url,
                source: 'NASA',
                timestamp: new Date().toISOString()
            }];
            await this.updateBuffer('astro', apod);
        } catch (e) {}
    }

    private static async refreshLiterature() {
        try {
            const response = await axios.get('https://openlibrary.org/trending/daily.json');
            const novels = response.data.works.map((w: any) => ({
                title: `[Novel] ${w.title}`,
                description: `Author: ${w.author_name?.join(', ') || 'Unknown'}. A trending piece in literature.`,
                url: `https://openlibrary.org${w.key}`,
                source: 'OpenLibrary',
                timestamp: new Date().toISOString()
            }));
            await this.updateBuffer('novels', novels);
        } catch (e) {}
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
                    user.lastLocationUpdate = new Date();
                    await user.save();
                } catch (e) {}
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
