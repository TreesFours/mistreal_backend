import axios from 'axios';

const NEWS_API_URL = 'https://newsapi.org/v2/top-headlines';

export const getNewsData = async (category: string = 'general', country: string = 'us') => {
    const apiKey = process.env.NEWS_API_KEY;

    if (!apiKey) {
        console.warn('NEWS_API_KEY is not set. Returning empty news.');
        return { articles: [] };
    }

    try {
        const response = await axios.get(NEWS_API_URL, {
            params: {
                category,
                country: country.length === 2 ? country : 'us', // Ensure 2-char code
                apiKey
            }
        });

        // ... rest of the code ...

        return {
            articles: response.data.articles.map((article: any) => ({
                title: article.title,
                description: article.description,
                url: article.url
            }))
        };
    } catch (error: any) {
        console.error('News Service Error:', error.response?.data || error.message);
        return { articles: [] };
    }
};
