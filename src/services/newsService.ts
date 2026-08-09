import axios from 'axios';
import { getAstroData, getWikipediaDeepDive, getSportsData, getMovieIntelligence, getNovelIntelligence, getJournalIntelligence } from './intelligenceService';
import { getDetailedAstroData } from './astroService';

export const getNewsData = async (category: string = 'general', country: string = 'us') => {
    const apiKey = process.env.NEWS_API_KEY;

    try {
        const [newsResp, nasaAstro, detailedAstro, wiki, sports, movies, novels, journals] = await Promise.all([
            apiKey ? axios.get(`https://newsapi.org/v2/top-headlines`, { params: { category, country, apiKey } }) : Promise.resolve({ data: { articles: [] } }),
            getAstroData(),
            getDetailedAstroData(),
            getWikipediaDeepDive(),
            getSportsData(),
            getMovieIntelligence(),
            getNovelIntelligence(),
            getJournalIntelligence()
        ]);

        const newsArticles = newsResp.data.articles.slice(0, 5).map((a: any) => ({
            title: a.title,
            description: a.description,
            url: a.url,
            source: 'News',
            timestamp: a.publishedAt || new Date().toISOString()
        }));

        // Combine all intelligence signals
        const allSignals = [
            ...newsArticles,
            ...nasaAstro,
            ...detailedAstro,
            ...wiki,
            ...sports,
            ...movies,
            ...novels,
            ...journals
        ];

        // 🕒 TIME-ORDERED INTERLEAVING
        // Sort by timestamp descending so latest news/socials appear first
        const sortedSignals = allSignals.sort((a: any, b: any) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        return { articles: sortedSignals };
    } catch (error) {
        return { articles: [] };
    }
};
