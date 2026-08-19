import axios from 'axios';
import logger from '../utils/logger';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// 🗺️ Category -> OpenStreetMap tag mapping (no API key required)
const CATEGORY_TAGS: Record<string, string[]> = {
    government: ['office=government', 'amenity=townhall', 'amenity=courthouse', 'amenity=police'],
    schools: ['amenity=school', 'amenity=university', 'amenity=college'],
    markets: ['shop=supermarket', 'shop=marketplace', 'amenity=marketplace'],
    banks: ['amenity=bank', 'amenity=atm'],
    medical: ['amenity=hospital', 'amenity=clinic', 'amenity=pharmacy', 'amenity=doctors'],
};

const DEFAULT_TAGS = ['amenity', 'shop', 'office'];

export interface DiscoveryPoi {
    name: string;
    address: string;
    category: string;
    latitude: number;
    longitude: number;
}

function resolveTags(category: string): string[] {
    return CATEGORY_TAGS[category.toLowerCase()] || DEFAULT_TAGS;
}

function buildQuery(lat: number, lon: number, radius: number, category: string): string {
    const tags = resolveTags(category);
    const filters = tags
        .map(tag => {
            const [key, value] = tag.split('=');
            const selector = value ? `["${key}"="${value}"]` : `["${key}"]`;
            return `  node${selector}(around:${radius},${lat},${lon});\n  way${selector}(around:${radius},${lat},${lon});`;
        })
        .join('\n');

    return `[out:json][timeout:15];\n(\n${filters}\n);\nout center 30;`;
}

export const getNearbyPlaces = async (lat: number, lon: number, radius: number, category: string): Promise<DiscoveryPoi[]> => {
    const safeRadius = Math.min(Math.max(radius, 50), 5000);

    try {
        const query = buildQuery(lat, lon, safeRadius, category);
        const response = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 20000,
        });

        const elements = response.data?.elements || [];
        const results: DiscoveryPoi[] = [];

        for (const el of elements) {
            const elLat = el.lat ?? el.center?.lat;
            const elLon = el.lon ?? el.center?.lon;
            if (elLat === undefined || elLon === undefined) continue;

            const tags = el.tags || {};
            const name = tags.name || `Unnamed ${category}`;
            const addressParts = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean);
            const address = addressParts.length > 0 ? addressParts.join(' ') : 'Address unavailable';

            results.push({ name, address, category, latitude: elLat, longitude: elLon });
        }

        // De-dupe by name+coords, cap at 25
        const seen = new Set<string>();
        return results
            .filter(r => {
                const key = `${r.name}:${r.latitude}:${r.longitude}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice(0, 25);
    } catch (e: any) {
        logger.error(`❌ Discovery Service Error: ${e.message}`);
        return [];
    }
};
