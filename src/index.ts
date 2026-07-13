import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { getAiResponse } from './services/aiService';
import { getSocialSummary } from './services/socialService';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// AI Chat Endpoint
app.post('/api/chat', async (req, res) => {
    const { prompt, provider, history } = req.body;

    if (!prompt) {
        return res.status(400).json({ success: false, error: 'Prompt is required' });
    }

    const response = await getAiResponse(prompt, provider || 'gemini', history || []);
    res.json(response);
});

// Info Endpoints (Placeholders for OpenWeather & GNews logic)
app.get('/api/weather', (req, res) => {
    res.json({
        summary: "Cloudy with a chance of rain",
        rainExpected: true,
        timeToRain: 45
    });
});

app.get('/api/news', (req, res) => {
    res.json({
        articles: [
            {
                title: "New AI Breakthrough",
                description: "AI is getting smarter every day...",
                url: "https://example.com"
            }
        ]
    });
});

app.get('/api/social/sync', async (req, res) => {
    const summary = await getSocialSummary();
    res.json(summary);
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
