import axios from 'axios';
import logger from '../utils/logger';

// 🛰️ Switched from free/anonymous Overpass to Geoapify's Places API. Overpass calls
// from this deployment's egress IP were failing consistently and near-instantly
// (~1.6s, every request, every mirror) — a pattern consistent with the public
// Overpass instances blocking/throttling cloud-hosting IP ranges outright, not
// intermittent overload. That's not something retries or more mirrors can fix.
// Geoapify has a genuine free tier (3,000 requests/day, no card required) with a
// documented, reliable API and the category-based filtering this app already uses.
const GEOAPIFY_URL = 'https://api.geoapify.com/v2/places';

// 🗺️ Category -> Geoapify Places taxonomy (https://apidocs.geoapify.com/docs/places/)
// NOTE: "road" was dropped — Geoapify's Places API is point-of-interest based, and a
// road is a line/way, not a place; it never had a sensible mapping here.
const CATEGORY_TAGS: Record<string, string[]> = {
    government: ['office.government', 'office.government.administrative', 'service.police', 'service.fire_station', 'tourism.sights.city_hall'],
    schools: ['education.school', 'education.university', 'education.college'],
    markets: ['commercial.supermarket', 'commercial.marketplace'],
    banks: ['service.financial.bank', 'service.financial.atm'],
    medical: ['healthcare.hospital', 'healthcare.clinic_or_praxis', 'healthcare.pharmacy'],
    rail: ['railway.train', 'public_transport.train'],
    waterbody: ['natural.water'],
    'religious building': ['religion.place_of_worship'],
    parks: ['leisure.park'],
};

const DEFAULT_TAGS = ['commercial', 'office', 'service'];

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

export interface DiscoveryOutcome {
    results: DiscoveryPoi[];
    // false only when the lookup itself failed (network/API error/no key) — lets the
    // client tell "genuinely nothing nearby" apart from "the map service didn't respond."
    succeeded: boolean;
}

export const getNearbyPlaces = async (lat: number, lon: number, radius: number, category: string): Promise<DiscoveryOutcome> => {
    const apiKey = process.env.GEOAPIFY_API_KEY;
    if (!apiKey) {
        logger.error('❌ Discovery Service Error: GEOAPIFY_API_KEY is not set');
        return { results: [], succeeded: false };
    }

    const safeRadius = Math.min(Math.max(radius, 50), 5000);
    const categories = resolveTags(category).join(',');

    try {
        const response = await axios.get(GEOAPIFY_URL, {
            params: {
                categories,
                filter: `circle:${lon},${lat},${safeRadius}`,
                limit: 30,
                apiKey,
            },
            timeout: 12000,
        });

        const features = response.data?.features || [];
        const results: DiscoveryPoi[] = [];

        for (const feature of features) {
            const props = feature.properties || {};
            const poiLat = props.lat ?? feature.geometry?.coordinates?.[1];
            const poiLon = props.lon ?? feature.geometry?.coordinates?.[0];
            if (poiLat === undefined || poiLon === undefined) continue;

            const name = props.name || `Unnamed ${category}`;
            const address = props.formatted || props.address_line2 || props.address_line1 || 'Address unavailable';

            results.push({ name, address, category, latitude: poiLat, longitude: poiLon });
        }

        // De-dupe by name+coords, cap at 25
        const seen = new Set<string>();
        const deduped = results
            .filter((r: any) => {
                const key = `${r.name}:${r.latitude}:${r.longitude}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice(0, 25);

        return { results: deduped, succeeded: true };
    } catch (e: any) {
        logger.error(`❌ Discovery Service Error (Geoapify, category=${category}): ${e.message}`);
        return { results: [], succeeded: false };
    }
};
