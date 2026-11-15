import axios from 'axios';
import logger from '../utils/logger';

export interface DisasterAlert {
    id: string;
    title: string;
    type: 'earthquake' | 'volcano' | 'tsunami' | 'cyclone' | 'flood';
    severity: string;
    locationName: string;
    latitude: number;
    longitude: number;
    magnitude?: number;
    depthKm?: number;
    timestamp: string;
    url: string;
    distanceKm?: number;
}

/**
 * 🌋 LIVE GLOBAL DISASTER RADAR SERVICE
 * 100% Free & Keyless APIs:
 * 1. USGS Earthquake API (earthquake.usgs.gov)
 * 2. GDACS Natural Disaster RSS/JSON (gdacs.org)
 */
export const getLiveDisasters = async (): Promise<DisasterAlert[]> => {
    const alerts: DisasterAlert[] = [];

    // 1. Fetch Real-Time Global Earthquakes M2.5+ from USGS
    try {
        const usgsUrl = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
        const usgsResp = await axios.get(usgsUrl, {
            params: {
                format: 'geojson',
                minmagnitude: '2.5',
                limit: 20,
                orderby: 'time'
            },
            timeout: 8000
        });

        const features = usgsResp.data?.features || [];
        features.forEach((f: any) => {
            const props = f.properties || {};
            const coords = f.geometry?.coordinates || [0, 0, 0];
            const lon = coords[0];
            const lat = coords[1];
            const depth = coords[2];
            const mag = props.mag || 2.5;

            alerts.push({
                id: `usgs_${f.id}`,
                title: `[Earthquake M${mag.toFixed(1)}] ${props.place || 'Unknown location'}`,
                type: 'earthquake',
                severity: mag >= 6.0 ? 'SEVERE' : (mag >= 4.5 ? 'MODERATE' : 'MINOR'),
                locationName: props.place || 'Unknown location',
                latitude: lat,
                longitude: lon,
                magnitude: mag,
                depthKm: depth,
                timestamp: props.time ? new Date(props.time).toISOString() : new Date().toISOString(),
                url: props.url || `https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}`
            });
        });
    } catch (e: any) {
        logger.warn(`⚠️ USGS Earthquake Feed Error: ${e.message}`);
    }

    // 2. Fetch GDACS Global Hazard Alerts (Volcanoes, Tsunamis, Cyclones)
    try {
        const gdacsUrl = 'https://www.gdacs.org/xml/rss.xml';
        const gdacsResp = await axios.get(gdacsUrl, { timeout: 8000 });
        const xml = gdacsResp.data || '';
        const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

        items.slice(0, 15).forEach((itemXml: string, index: number) => {
            const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/);
            const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/);
            const descriptionMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/);
            const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
            const pointMatch = itemXml.match(/<georss:point>([\s\S]*?)<\/georss:point>/);

            if (titleMatch) {
                const title = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
                const link = linkMatch ? linkMatch[1].trim() : 'https://www.gdacs.org';
                const description = descriptionMatch ? descriptionMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : title;
                const pubDate = pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString();

                let lat = 0, lon = 0;
                if (pointMatch) {
                    const pts = pointMatch[1].trim().split(/\s+/);
                    lat = parseFloat(pts[0]) || 0;
                    lon = parseFloat(pts[1]) || 0;
                }

                const lowerTitle = title.toLowerCase();
                let type: DisasterAlert['type'] = 'cyclone';
                if (lowerTitle.includes('earthquake')) type = 'earthquake';
                else if (lowerTitle.includes('volcano') || lowerTitle.includes('eruption')) type = 'volcano';
                else if (lowerTitle.includes('tsunami')) type = 'tsunami';
                else if (lowerTitle.includes('flood')) type = 'flood';

                alerts.push({
                    id: `gdacs_${index}_${Date.now()}`,
                    title: `[GDACS Alert] ${title}`,
                    type,
                    severity: lowerTitle.includes('red') ? 'CRITICAL' : (lowerTitle.includes('orange') ? 'SEVERE' : 'MODERATE'),
                    locationName: title,
                    latitude: lat,
                    longitude: lon,
                    timestamp: pubDate,
                    url: link
                });
            }
        });
    } catch (e: any) {
        logger.warn(`⚠️ GDACS Disaster Feed Error: ${e.message}`);
    }

    return alerts;
};

/**
 * 📡 Calculates distance between user location and hazard alert (Haversine)
 */
export const calculateDistanceKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371; // Earth radius km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
};
