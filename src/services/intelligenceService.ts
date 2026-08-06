import axios from 'axios';
import logger from '../utils/logger';

export const getAstroData = async () => {
    const nasaKey = process.env.NASA_API_KEY;
    if (!nasaKey) return [];

    try {
        const response = await axios.get('https://api.nasa.gov/planetary/apod', {
            params: { api_key: nasaKey }
        });
        return [{
            title: `[Astro] ${response.data.title}`,
            description: response.data.explanation,
            url: response.data.url,
            source: 'NASA',
            timestamp: new Date().toISOString()
        }];
    } catch (e) { return []; }
};

export const getWikipediaDeepDive = async () => {
    try {
        const response = await axios.get('https://en.wikipedia.org/api/rest_v1/page/random/summary');
        return [{
            title: `[Deep Dive] ${response.data.title}`,
            description: response.data.extract,
            url: response.data.content_urls.desktop.page,
            source: 'Wikipedia',
            timestamp: new Date().toISOString()
        }];
    } catch (e) { return []; }
};

export const getSportsData = async () => {
    const apiKey = process.env.NEWS_API_KEY;
    if (!apiKey) return [];
    try {
        // Broadening to multiple sports categories
        const response = await axios.get(`https://newsapi.org/v2/top-headlines`, {
            params: { category: 'sports', country: 'us', apiKey }
        });
        return response.data.articles.slice(0, 5).map((a: any) => ({
            title: `[Sports] ${a.title}`,
            description: a.description,
            url: a.url,
            source: 'Sports',
            timestamp: a.publishedAt || new Date().toISOString()
        }));
    } catch (e) { return []; }
};

export const getMovieIntelligence = async () => {
    const tmdbKey = process.env.TMDB_API_KEY;
    if (!tmdbKey) return [];
    try {
        const response = await axios.get('https://api.themoviedb.org/3/movie/now_playing', {
            params: { api_key: tmdbKey }
        });
        return response.data.results.slice(0, 3).map((m: any) => ({
            title: `[Movie] ${m.title}`,
            description: m.overview,
            url: `https://www.themoviedb.org/movie/${m.id}`,
            source: 'TMDB',
            timestamp: new Date().toISOString()
        }));
    } catch (e) { return []; }
};

export const getNovelIntelligence = async () => {
    try {
        // Using OpenLibrary for latest/trending books
        const response = await axios.get('https://openlibrary.org/trending/daily.json');
        return response.data.works.slice(0, 3).map((w: any) => ({
            title: `[Novel] ${w.title}`,
            description: `Author: ${w.author_name?.join(', ') || 'Unknown'}. A trending piece in literature.`,
            url: `https://openlibrary.org${w.key}`,
            source: 'OpenLibrary',
            timestamp: new Date().toISOString()
        }));
    } catch (e) { return []; }
};
