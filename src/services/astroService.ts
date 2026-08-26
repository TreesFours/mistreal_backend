import axios from 'axios';
import logger from '../utils/logger';

/**
 * 🌙 Professional Astronomy Service
 * Fetches Moon phases and Planet positions using AstronomyAPI
 */
export const getDetailedAstroData = async (lat: number = 0, lon: number = 0) => {
    const appId = process.env.ASTRONOMY_API_ID;
    const appSecret = process.env.ASTRONOMY_API_SECRET;

    if (!appId || !appSecret) {
        logger.warn("⚠️ AstronomyAPI credentials missing in environment. Skipping astro data.");
        return null;
    }

    const auth = Buffer.from(`${appId}:${appSecret}`).toString('base64');
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toISOString().split('T')[1].split('.')[0];

    try {
        // 1. Fetch Moon Phase & Image
        const moonResponse = await axios.post('https://api.astronomyapi.com/api/v2/studio/moon-phase', {
            format: 'png',
            style: { moonStyle: 'sketch', backgroundColor: 'black', fontColor: 'white', fontSize: 12 },
            observer: { latitude: lat, longitude: lon, date: dateStr },
            view: { type: 'landscape-simple', orientation: 'north-up' }
        }, {
            headers: { 'Authorization': `Basic ${auth}` }
        });

        // 2. Fetch Visible Planet Positions for the observer
        // We use the positions endpoint to get Altitude/Azimuth for human-centric observation
        const planetsResponse = await axios.get('https://api.astronomyapi.com/api/v2/bodies/positions', {
            params: {
                latitude: lat,
                longitude: lon,
                elevation: 0,
                from_date: dateStr,
                to_date: dateStr,
                time: timeStr
            },
            headers: { 'Authorization': `Basic ${auth}` }
        });

        const moonPhaseName = getMoonPhaseName(now);

        // Extract Planet Data
        const planetPositions = planetsResponse.data?.data?.table?.rows || [];
        const visiblePlanets = planetPositions
            .filter((r: any) => ['mercury', 'venus', 'mars', 'jupiter', 'saturn'].includes(r.entry.id))
            .map((r: any) => {
                const pos = r.cells[0].position.horizonal;
                const alt = parseFloat(pos.altitude.degrees);
                const az = parseFloat(pos.azimuth.degrees);
                return {
                    name: r.entry.name,
                    id: r.entry.id,
                    altitude: alt,
                    azimuth: az,
                    direction: getCompassDirection(az),
                    isVisible: alt > 0
                };
            });

        // Extract Moon position for proximity checks
        const moonPosRow = planetPositions.find((r: any) => r.entry.id === 'moon');
        const moonAz = moonPosRow ? parseFloat(moonPosRow.cells[0].position.horizonal.azimuth.degrees) : 0;
        const moonAlt = moonPosRow ? parseFloat(moonPosRow.cells[0].position.horizonal.altitude.degrees) : 0;

        // Calculate "Near Moon" (within ~15 degrees)
        const planetsWithProximity = visiblePlanets.map(p => {
            const azDiff = Math.abs(p.azimuth - moonAz);
            const altDiff = Math.abs(p.altitude - moonAlt);
            const distance = Math.sqrt(azDiff * azDiff + altDiff * altDiff);
            return { ...p, isNearMoon: distance < 15 && p.isVisible };
        });

        return {
            moon: {
                phase: moonPhaseName,
                imageUrl: moonResponse.data?.data?.imageUrl || "",
                azimuth: moonAz,
                altitude: moonAlt,
                direction: getCompassDirection(moonAz)
            },
            planets: planetsWithProximity,
            summary: `Moon: ${moonPhaseName}. Visible: ${planetsWithProximity.filter(p => p.isVisible).map(p => p.name).join(', ') || 'None'}.`
        };
    } catch (error: any) {
        logger.error(`❌ AstronomyAPI Failure:`, error.message);
        return null;
    }
};

function getCompassDirection(bearing: number): string {
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const index = Math.round(bearing / 45) % 8;
    return directions[index];
}

function getMoonPhaseName(date: Date): string {
    const now = date.getTime() / 1000;
    const new_moon = 2451550.1; // Jan 6 2000
    const phase = ((now / 86400) + 2440587.5 - new_moon) % 29.530588853;
    const res = phase / 29.530588853;

    if (res < 0.03 || res > 0.97) return "New Moon";
    if (res < 0.22) return "Waxing Crescent";
    if (res < 0.28) return "First Quarter";
    if (res < 0.47) return "Waxing Gibbous";
    if (res < 0.53) return "Full Moon";
    if (res < 0.72) return "Waning Gibbous";
    if (res < 0.78) return "Last Quarter";
    return "Waning Crescent";
}

export const getJplVectorData = async (bodyId: string) => {
    const nasaKey = process.env.NASA_API_KEY;
    if (!nasaKey) return null;
    try {
        const response = await axios.get('https://ssd.jpl.nasa.gov/api/horizons.api', {
            params: {
                format: 'json',
                COMMAND: `'${bodyId}'`,
                OBJ_DATA: 'YES',
                MAKE_EPHEM: 'YES',
                EPHEM_TYPE: 'VECTORS',
                CENTER: '500@0',
                START_TIME: 'now',
                STOP_TIME: 'now + 1 minute',
                STEP_SIZE: '1m',
                VEC_TABLE: '2'
            }
        });
        return response.data;
    } catch (e: any) {
        logger.error(`❌ JPL Horizons Failure: ${e.message}`);
        return null;
    }
};
