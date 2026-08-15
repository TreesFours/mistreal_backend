import axios from 'axios';
import { Op } from 'sequelize';
import logger from '../utils/logger';
import { IntelligenceBuffer, User } from '../models/userModel';
import { getWeatherData } from './weatherService';

/**
 * 🛰️ STRATEGIC INTELLIGENCE SERVICE
 * Implements the "Rolling 15 Flow" and "Proactive Weather" logic.
 */
export class IntelligenceService {

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
            const uniqueNewItems = newItems.filter(newItem =>
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

        // 1. News (Hourly)
        await this.refreshNews();

        // 2. Entertainment (Hourly)
        await this.refreshEntertainment();

        // 3. NASA APOD (Daily)
        await this.refreshAstro();

        // 4. Novels (Daily)
        await this.refreshLiterature();
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
     * Refreshes weather for all active users based on their last known location.
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
     * Returns the consolidated feed for the app.
     * 🕒 INTERLEAVED & RANDOMIZED FLOW
     */
    static async getGlobalFeed() {
        const buffers = await IntelligenceBuffer.findAll();
        let allItems: any[] = [];

        buffers.forEach(buffer => {
            allItems = [...allItems, ...(buffer.items || [])];
        });

        // 🌪️ STRATEGIC MIXING:
        // 1. Sort by date (descending) to ensure latest is always near top
        // 2. Add a tiny bit of random jitter within items of same hour to keep it fresh
        return allItems.sort((a, b) => {
            const timeA = new Date(a.timestamp).getTime();
            const timeB = new Date(b.timestamp).getTime();

            // If they are from the same hour, randomize thier relative position
            if (Math.abs(timeA - timeB) < 3600000) {
                return 0.5 - Math.random();
            }

            return timeB - timeA;
        });
    }
}
