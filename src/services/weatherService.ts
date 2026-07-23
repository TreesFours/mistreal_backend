import axios from 'axios';

const WEATHER_API_URL = 'https://api.openweathermap.org/data/2.5/weather';

export const getWeatherData = async (lat: number, lon: number) => {
    const apiKey = process.env.OPENWEATHER_API_KEY;

    if (!apiKey) {
        console.warn('OPENWEATHER_API_KEY is not set. Returning placeholder weather.');
        return {
            summary: "Weather service unavailable (Missing API Key).",
            location: "Unknown",
            rainExpected: false,
            timeToRain: 0
        };
    }

    try {
        const response = await axios.get(WEATHER_API_URL, {
            params: {
                lat,
                lon,
                appid: apiKey,
                units: 'metric'
            }
        });

        const weather = response.data;
        const rain = weather.rain ? weather.rain['1h'] || 0 : 0;

        return {
            summary: `${weather.weather[0].description.charAt(0).toUpperCase() + weather.weather[0].description.slice(1)}. Temperature: ${weather.main.temp}°C.`,
            location: weather.name || "Unknown Location",
            rainExpected: rain > 0,
            timeToRain: rain > 0 ? 30 : null
        };
    } catch (error: any) {
        console.error('Weather Service Error:', error.response?.data || error.message);
        return {
            summary: "Error fetching weather data.",
            location: "Error",
            rainExpected: false,
            timeToRain: null
        };
    }
};
