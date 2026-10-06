import axios from 'axios';
import * as admin from 'firebase-admin';
import logger from '../utils/logger';

/**
 * Finds a representative photo for a pinned/searched location.
 *
 * Two tiers, both optional and independently fail-safe — if neither key is
 * configured, this just returns null and the intel-save flow continues
 * without an image, same as today:
 *
 * 1. Pexels (PEXELS_API_KEY) — free, no billing account needed, generous
 *    rate limit. Keyword search against the location's label text. Returns
 *    a public CDN URL directly — safe to hand straight to the client, since
 *    that URL never contains our API key.
 * 2. Google Places (GOOGLE_PLACES_API_KEY) — an actual photo of that real
 *    place when one exists (not just a generic stock photo matching the
 *    name), tried first when configured since it's more precise. Google's
 *    Place Photo endpoint requires the key to be appended to the image URL
 *    itself, which would leak it to every client that ever loads the image —
 *    so instead of returning that URL directly, the photo bytes are fetched
 *    server-side and re-hosted on Firebase Storage (same pattern already
 *    used for WhatsApp media in webhookService.ts), and only the resulting
 *    Firebase public URL — which contains no secret — ever reaches the app.
 */
export const getLocationPhoto = async (label: string, lat: number, lon: number): Promise<string | null> => {
    const googleKey = process.env.GOOGLE_PLACES_API_KEY;
    if (googleKey) {
        try {
            const photoUrl = await getGooglePlacesPhoto(label, lat, lon, googleKey);
            if (photoUrl) return photoUrl;
        } catch (e: any) {
            logger.warn(`⚠️ Google Places photo lookup failed for "${label}": ${e.message}`);
        }
    }

    const pexelsKey = process.env.PEXELS_API_KEY;
    if (pexelsKey) {
        try {
            const photoUrl = await getPexelsPhoto(label, pexelsKey);
            if (photoUrl) return photoUrl;
        } catch (e: any) {
            logger.warn(`⚠️ Pexels photo lookup failed for "${label}": ${e.message}`);
        }
    }

    return null;
};

const getPexelsPhoto = async (label: string, apiKey: string): Promise<string | null> => {
    const response = await axios.get('https://api.pexels.com/v1/search', {
        params: { query: label, per_page: 1 },
        headers: { Authorization: apiKey },
        timeout: 8000
    });
    return response.data?.photos?.[0]?.src?.medium || null;
};

const getGooglePlacesPhoto = async (label: string, lat: number, lon: number, apiKey: string): Promise<string | null> => {
    const findResponse = await axios.get('https://maps.googleapis.com/maps/api/place/findplacefromtext/json', {
        params: {
            input: label,
            inputtype: 'textquery',
            locationbias: `point:${lat},${lon}`,
            fields: 'place_id,photos',
            key: apiKey
        },
        timeout: 8000
    });

    const candidate = findResponse.data?.candidates?.[0];
    const photoReference = candidate?.photos?.[0]?.photo_reference;
    if (!photoReference) return null;

    const photoResponse = await axios.get('https://maps.googleapis.com/maps/api/place/photo', {
        params: { maxwidth: 400, photo_reference: photoReference, key: apiKey },
        responseType: 'arraybuffer',
        timeout: 8000
    });

    const contentType = photoResponse.headers['content-type']?.toString() || 'image/jpeg';
    const bucket = admin.storage().bucket();
    const fileName = `location_photos/${candidate.place_id || Date.now()}`;
    const file = bucket.file(fileName);
    await file.save(Buffer.from(photoResponse.data), { metadata: { contentType } });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/${fileName}`;
};
