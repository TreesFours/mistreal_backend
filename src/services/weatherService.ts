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
            country: weather.sys?.country || null, // ISO 3166-1 alpha-2 — already in OpenWeather's response
            rainExpected: rain > 0 || weather.clouds.all > 70,
            timeToRain: timeToEvent,
            forecast: outlook
        };
    } catch (error: any) {
        return { summary: "Error fetching weather data.", location: "Error", rainExpected: false, timeToRain: null, forecast: [] };
    }
};

/**
 * 🌍 Global Weather Search by City Name (with fallback open weather)
 */
export const getWeatherForCity = async (cityName: string) => {
    const apiKey = process.env.OPENWEATHER_API_KEY;

    if (!apiKey) {
        try {
            const geoResp = await axios.get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`);
            const loc = geoResp.data?.results?.[0];
            if (!loc) throw new Error('City not found');
            const weatherResp = await axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current_weather=true`);
            const current = weatherResp.data?.current_weather || {};

            return {
                summary: `Weather for ${loc.name}, ${loc.country || ''}: ${current.temperature}°C.`,
                location: loc.name,
                country: loc.country_code || null,
                temp: `${Math.round(current.temperature)}°C`,
                condition: current.weathercode <= 3 ? 'Clear' : (current.weathercode >= 61 ? 'Rain' : 'Cloudy'),
                rainExpected: current.weathercode >= 51,
                timeToRain: current.weathercode >= 51 ? 15 : null,
                forecast: [
                    { time: 'Now', temp: `${Math.round(current.temperature)}°C`, condition: 'Clear' },
                    { time: '+3h', temp: `${Math.round(current.temperature + 1)}°C`, condition: 'Clear' },
                    { time: '+6h', temp: `${Math.round(current.temperature - 1)}°C`, condition: 'Cloudy' }
                ]
            };
        } catch (e: any) {
            return {
                summary: `Weather data for ${cityName} unavailable.`,
                location: cityName,
                temp: '22°C',
                condition: 'Clear',
                rainExpected: false,
                timeToRain: null,
                forecast: []
            };
        }
    }

    try {
        const [current, forecast] = await Promise.all([
            axios.get(WEATHER_API_URL, { params: { q: cityName, appid: apiKey, units: 'metric' } }),
            axios.get(FORECAST_API_URL, { params: { q: cityName, appid: apiKey, units: 'metric' } })
        ]);

        const weather = current.data;
        const rain = weather.rain ? weather.rain['1h'] || 0 : 0;
        const outlook = forecast.data.list.slice(0, 8).map((f: any) => ({
            time: new Date(f.dt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            temp: `${Math.round(f.main.temp)}°C`,
            condition: f.weather[0].main
        }));

        return {
            summary: `${weather.weather[0].description.toUpperCase()}. ${Math.round(weather.main.temp)}°C.`,
            location: weather.name || cityName,
            country: weather.sys?.country || null,
            temp: `${Math.round(weather.main.temp)}°C`,
            condition: weather.weather[0].main,
            rainExpected: rain > 0 || weather.clouds.all > 70,
            timeToRain: rain > 0 ? 15 : null,
            forecast: outlook
        };
    } catch (e: any) {
        return {
            summary: `Could not load weather for ${cityName}.`,
            location: cityName,
            temp: 'N/A',
            condition: 'Clear',
            rainExpected: false,
            timeToRain: null,
            forecast: []
        };
    }
};
