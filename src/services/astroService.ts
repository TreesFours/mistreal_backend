import axios from 'axios';
import logger from '../utils/logger';

/**
 * 🌙 Professional Astronomy Service
 * Fetches Moon phases and Planet positions using AstronomyAPI
 */
export const getDetailedAstroData = async () => {
    const appId = process.env.ASTRONOMY_API_ID;
    const appSecret = process.env.ASTRONOMY_API_SECRET;

    if (!appId || !appSecret) {
        logger.warn("⚠️ AstronomyAPI credentials missing in environment. Skipping astro data.");
        return [];
    }

    // 🔐 AUTH: AstronomyAPI uses Basic Auth (AppID:AppSecret encoded in Base64)
    const auth = Buffer.from(`${appId}:${appSecret}`).toString('base64');

    try {
        const dateStr = new Date().toISOString().split('T')[0];

        // 1. Fetch Moon Phase Image
        // Use a generic observer (Lat 0, Lon 0) for the global feed
        const moonResponse = await axios.post('https://api.astronomyapi.com/api/v2/studio/moon-phase', {
            format: 'png',
            style: { moonStyle: 'sketch', backgroundColor: 'black', fontColor: 'white', fontSize: 12 },
            observer: { latitude: 0, longitude: 0, date: dateStr },
            view: { type: 'landscape-simple', orientation: 'north-up' }
        }, {
            headers: { 'Authorization': `Basic ${auth}` }
        });

        // 2. Fetch Planetary Positions for Earth-relative context
        const planetsResponse = await axios.get('https://api.astronomyapi.com/api/v2/bodies', {
            headers: { 'Authorization': `Basic ${auth}` }
        });

        const majorPlanets = planetsResponse.data?.data?.table?.rows
            ?.filter((r: any) => ['mercury', 'venus', 'mars', 'jupiter', 'saturn'].includes(r.entry.id))
            ?.map((r: any) => r.entry.name)
            ?.join(', ') || "Planetary alignment data unavailable";

        return [{
            title: "[Astro] Celestial Intelligence",
            description: `Moon phase data captured for ${dateStr}. Notable planetary positions relative to Earth: ${majorPlanets}.`,
            url: moonResponse.data?.data?.imageUrl || "",
            source: 'AstronomyAPI',
            timestamp: new Date().toISOString()
        }];
    } catch (error: any) {
        logger.error(`❌ AstronomyAPI Failure [ID: ${appId.slice(0, 4)}...]:`, error.message);
        return [];
    }
};

/**
 * 🛰️ NASA JPL Horizons Integration
 * Fetches exact Cartesian vectors for scale-perfect mapping
 */
export const getJplVectorData = async (bodyId: string) => {
    const nasaKey = process.env.NASA_API_KEY;
    if (!nasaKey) return null;

    try {
        // JPL Horizons API for precision tracking
        const response = await axios.get('https://ssd.jpl.nasa.gov/api/horizons.api', {
            params: {
                format: 'json',
                COMMAND: `'${bodyId}'`,
                OBJ_DATA: 'YES',
                MAKE_EPHEM: 'YES',
                EPHEM_TYPE: 'VECTORS',
                CENTER: '500@0', // Solar System Barycenter
                START_TIME: 'now',
                STOP_TIME: 'now + 1 minute',
                STEP_SIZE: '1m',
                VEC_TABLE: '2' // Position vectors only
            }
        });

        return response.data;
    } catch (e: any) {
        logger.error(`❌ JPL Horizons Failure: ${e.message}`);
        return null;
    }
};
