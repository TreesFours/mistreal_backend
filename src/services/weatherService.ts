import axios from 'axios';

const WEATHER_API_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_API_URL = 'https://api.openweathermap.org/data/2.5/forecast';

export const getWeatherData = async (lat: number, lon: number) => {
    const apiKey = process.env.OPENWEATHER_API_KEY;

    if (!apiKey) {
        return {
            summary: "Weather service unavailable (Missing API Key).",
            location: "Unknown",
            rainExpected: false,
            timeToRain: 0,
            forecast: []
        };
    }

    try {
        const [current, forecast] = await Promise.all([
            axios.get(WEATHER_API_URL, { params: { lat, lon, appid: apiKey, units: 'metric' } }),
            axios.get(FORECAST_API_URL, { params: { lat, lon, appid: apiKey, units: 'metric' } })
        ]);

        const weather = current.data;
        const rain = weather.rain ? weather.rain['1h'] || 0 : 0;

        // 🌡️ Forecast Processing
        const outlook = forecast.data.list.slice(0, 8).map((f: any) => ({
            time: new Date(f.dt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            temp: `${Math.round(f.main.temp)}°C`,
            condition: f.weather[0].main
        }));

        let rainStatus = "No precipitation detected.";
        let timeToEvent = null;
        if (rain > 0) { timeToEvent = 45; }
        else if (weather.clouds.all > 70) { timeToEvent = 20; }

        return {
            summary: `${weather.weather[0].description.toUpperCase()}. ${Math.round(weather.main.temp)}°C.`,
            location: weather.name || "Tactical Sector",
            rainExpected: rain > 0 || weather.clouds.all > 70,
            timeToRain: timeToEvent,
            forecast: outlook
        };
    } catch (error: any) {
        return { summary: "Error fetching weather data.", location: "Error", rainExpected: false, timeToRain: null, forecast: [] };
    }
};
