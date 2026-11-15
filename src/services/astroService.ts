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
        const planetsWithProximity = visiblePlanets.map((p: any) => {
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
            summary: `Moon: ${moonPhaseName}. Visible: ${planetsWithProximity.filter((p: any) => p.isVisible).map((p: any) => p.name).join(', ') || 'None'}.`
        };
    } catch (error: any) {
        logger.error(`❌ AstronomyAPI Failure:`, error.message);
        return null;
    }
};

export interface NasaApodData {
    title: string;
    explanation: string;
    url: string;
    hdurl?: string;
    mediaType: string;
    date: string;
}

export const getNasaApod = async (): Promise<NasaApodData | null> => {
    const nasaKey = process.env.NASA_API_KEY || 'DEMO_KEY';
    try {
        const response = await axios.get('https://api.nasa.gov/planetary/apod', {
            params: { api_key: nasaKey },
            timeout: 10000
        });
        const data = response.data;
        if (!data || !data.title) return null;
        return {
            title: data.title,
            explanation: data.explanation || 'NASA Astronomy Picture of the Day',
            url: data.url,
            hdurl: data.hdurl || data.url,
            mediaType: data.media_type || 'image',
            date: data.date || new Date().toISOString().split('T')[0]
        };
    } catch (e: any) {
        logger.warn(`⚠️ [Astro] getNasaApod failed: ${e.message}`);
        return null;
    }
};

export interface SpaceNewsArticle {
    title: string;
    summary: string;
    url: string;
    imageUrl?: string;
    publishedAt: string;
    newsSite: string;
}

export const getSpaceNews = async (): Promise<SpaceNewsArticle[]> => {
    try {
        const response = await axios.get('https://api.spaceflightnewsapi.net/v4/articles/', {
            params: { limit: 10 },
            timeout: 10000
        });
        const results = response.data?.results || [];
        return results.map((a: any) => ({
            title: a.title,
            summary: a.summary || 'Spaceflight news and orbital telemetry.',
            url: a.url,
            imageUrl: a.image_url || undefined,
            publishedAt: a.published_at || new Date().toISOString(),
            newsSite: a.news_site || 'Spaceflight News'
        }));
    } catch (e: any) {
        logger.warn(`⚠️ [Astro] getSpaceNews failed: ${e.message}`);
        return [];
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

export const getJplObserverData = async (bodyId: string, lat: number, lon: number) => {
    try {
        const moonAziAlt = bodyId === '301' ? null : await getMoonAziAlt(lat, lon);

        const response = await axios.get('https://ssd.jpl.nasa.gov/api/horizons.api', {
            params: {
                format: 'json',
                COMMAND: `'${bodyId}'`,
                OBJ_DATA: 'YES',
                MAKE_EPHEM: 'YES',
                EPHEM_TYPE: 'OBSERVER',
                CENTER: 'coord@399',
                COORD_TYPE: 'GEODETIC',
                SITE_COORD: `'${lon},${lat},0'`,
                START_TIME: 'now',
                STOP_TIME: 'now + 1 minute',
                STEP_SIZE: '1m',
                QUANTITIES: '1,4,19,20'
            },
            timeout: 10000
        });

        const result = response.data?.result;
        if (!result) return null;

        const lines = result.split('\n');
        let azimuth = 0, elevation = 0, distEarth = "N/A", distSun = "N/A";

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('$$SOE')) {
                const dataLine = lines[i + 1] || '';
                // Robust regex tokenization of numeric fields after timestamp
                const cleanLine = dataLine.replace(/^\s*\d{4}-\w{3}-\d{2}\s+\d{2}:\d{2}\s*(\*m|\*|\s)?/, '').trim();
                const numMatches = cleanLine.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];

                if (numMatches.length >= 7) {
                    // Index 4: Azimuth, Index 5: Elevation, Index 6: Delta (Earth AU), Index 8: Rho (Sun AU)
                    azimuth = parseFloat(numMatches[4]) || 0;
                    elevation = parseFloat(numMatches[5]) || 0;
                    const deltaVal = parseFloat(numMatches[6]);
                    const rhoVal = parseFloat(numMatches[8]);
                    if (!isNaN(deltaVal)) distEarth = `${deltaVal.toFixed(3)} AU`;
                    if (!isNaN(rhoVal)) distSun = `${rhoVal.toFixed(3)} AU`;
                }
                break;
            }
        }

        let description = "";
        const descMatch = result.match(/PHYSICAL DATA([\s\S]*?)----/);
        if (descMatch) {
            description = descMatch[1].trim().split('\n').slice(0, 5).join('; ');
        }

        const orientation = getCompassDirection(azimuth);

        let relativeToMoon = "Moon position unknown";
        if (moonAziAlt) {
            const azDiff = azimuth - moonAziAlt.azimuth;
            const altDiff = elevation - moonAziAlt.elevation;
            const vert = altDiff > 5 ? "Above" : (altDiff < -5 ? "Below" : "Level with");
            const horiz = azDiff > 10 ? "East of" : (azDiff < -10 ? "West of" : "");
            relativeToMoon = `${vert} ${horiz} the Moon`.trim();
        }

        const bodyCatalog: Record<string, { name: string, category: string }> = {
            '10': { name: 'Sun', category: 'sun' },
            '199': { name: 'Mercury', category: 'planet' },
            '299': { name: 'Venus', category: 'planet' },
            '399': { name: 'Earth', category: 'planet' },
            '301': { name: 'Moon', category: 'moon' },
            '499': { name: 'Mars', category: 'planet' },
            '401': { name: 'Phobos', category: 'moon' },
            '402': { name: 'Deimos', category: 'moon' },
            '599': { name: 'Jupiter', category: 'planet' },
            '501': { name: 'Io', category: 'moon' },
            '502': { name: 'Europa', category: 'moon' },
            '503': { name: 'Ganymede', category: 'moon' },
            '504': { name: 'Callisto', category: 'moon' },
            '699': { name: 'Saturn', category: 'planet' },
            '606': { name: 'Titan', category: 'moon' },
            '799': { name: 'Uranus', category: 'planet' },
            '899': { name: 'Neptune', category: 'planet' },
            '801': { name: 'Triton', category: 'moon' },
            '999': { name: 'Pluto', category: 'planet' },
            '1': { name: 'Ceres', category: 'asteroid' },
            '4': { name: 'Vesta', category: 'asteroid' },
            '433': { name: 'Eros', category: 'asteroid' },
            '99942': { name: 'Apophis', category: 'asteroid' }
        };

        const meta = bodyCatalog[bodyId] || { name: `Celestial Body ${bodyId}`, category: 'asteroid' };

        return {
            body: bodyId,
            name: meta.name,
            category: meta.category,
            azimuth,
            elevation,
            orientation,
            distEarth,
            distSun,
            description: description || `${meta.name} ephemeris tracked via JPL Horizons vector coordinate system.`,
            relativeToMoon,
            status: elevation > 0 ? "Visible" : "Below Horizon"
        };
    } catch (e: any) {
        logger.error(`❌ JPL Observer Failure for body ${bodyId}: ${e.message}`);
        return null;
    }
};

/**
 * ☄️ NASA NeoWS API — Near-Earth Asteroid Feed
 */
export const getNearEarthAsteroids = async (): Promise<any[]> => {
    const nasaKey = process.env.NASA_API_KEY || 'DEMO_KEY';
    try {
        const today = new Date().toISOString().split('T')[0];
        const response = await axios.get('https://api.nasa.gov/neo/rest/v1/feed/today', {
            params: { api_key: nasaKey, detail: 'false' },
            timeout: 10000
        });

        const nearEarthObjects = response.data?.near_earth_objects?.[today] || [];
        return nearEarthObjects.slice(0, 10).map((neo: any) => {
            const closeApproach = neo.close_approach_data?.[0] || {};
            const distAu = parseFloat(closeApproach.miss_distance?.astronomical || '0').toFixed(3);
            const speedKmh = parseFloat(closeApproach.relative_velocity?.kilometers_per_hour || '0').toFixed(0);
            return {
                id: `neo_${neo.id}`,
                name: neo.name || `Asteroid ${neo.id}`,
                category: 'asteroid',
                distEarth: `${distAu} AU`,
                distSun: 'Tracking Orbit',
                status: neo.is_potentially_hazardous_asteroid ? 'Hazardous NEO' : 'Safe Flyby',
                description: `Near-Earth Asteroid. Velocity: ${speedKmh} km/h. Est. Diameter: ${neo.estimated_diameter?.meters?.estimated_diameter_max?.toFixed(0) || 'N/A'}m.`,
                azimuth: 0,
                elevation: 0,
                orientation: 'N/A',
                relativeToMoon: 'Near-Earth Trajectory'
            };
        });
    } catch (e: any) {
        logger.warn(`⚠️ NASA NeoWS Asteroid Feed Warning: ${e.message}`);
        return [];
    }
};

const getMoonAziAlt = async (lat: number, lon: number) => {
    try {
        const response = await axios.get('https://ssd.jpl.nasa.gov/api/horizons.api', {
            params: {
                format: 'json',
                COMMAND: "'301'",
                MAKE_EPHEM: 'YES',
                EPHEM_TYPE: 'OBSERVER',
                CENTER: 'coord@399',
                COORD_TYPE: 'GEODETIC',
                SITE_COORD: `'${lon},${lat},0'`,
                START_TIME: 'now',
                STOP_TIME: 'now + 1 minute',
                STEP_SIZE: '1m',
                QUANTITIES: '4'
            }
        });
        const lines = response.data.result.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('$$SOE')) {
                const parts = lines[i+1].trim().split(/\s+/);
                return { azimuth: parseFloat(parts[4]), elevation: parseFloat(parts[5]) };
            }
        }
    } catch (e: any) {
        logger.warn(`⚠️ [Astro] getMoonAziAlt failed (relativeToMoon will read "unknown"): ${e.message}`);
    }
    return null;
};
