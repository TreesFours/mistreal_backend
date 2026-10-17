import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { Business } from '../models/businessModel';
import { MeetupProposal } from '../models/MeetupProposal';
import { MeetupConfirmation } from '../models/MeetupConfirmation';
import { persistToStorage } from './adRoutes';
import { Ad } from '../models/adModel';
import { getNearbyPlaces } from '../services/discoveryService';
import logger from '../utils/logger';

const router = Router();

// Haversine distance in km — plain JS rather than a Postgres extension
// (PostGIS/earthdistance) since this app has no geo extension set up
// anywhere else; fine at the current scale (candidates are already
// narrowed by category/name/address before this runs).
const distanceKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// How many km of "closeness" one nearby confirmed meetup is worth when
// ranking search results — e.g. a business with 3 confirmed meetups near
// the searching user effectively looks 3 * this much closer than it really
// is. Tunable without a redeploy.
const NEARBY_MEETUP_RADIUS_KM = parseFloat(process.env.SEARCH_NEARBY_MEETUP_RADIUS_KM || '25');
// How far out to look for external (non-Mistreal) results when nothing
// native matches — Geoapify's own Places API caps this at 5000m regardless.
const SEARCH_EXTERNAL_RADIUS_METERS = parseFloat(process.env.SEARCH_EXTERNAL_RADIUS_METERS || '5000');
const NEARBY_MEETUP_BOOST_KM = parseFloat(process.env.SEARCH_NEARBY_MEETUP_BOOST_KM || '2');
// A business running a paid ad ranks above pure proximity/trust — bigger
// than the meetup-trust boost since this is a paid placement, not earned
// history. Only businesses have ads (individuals can only tag skills —
// see needRoutes.ts), so this never applies outside this search.
const AD_BOOST_KM = parseFloat(process.env.SEARCH_AD_BOOST_KM || '10');

/**
 * One-time upload for the owner's profile photo — either their live-
 * captured Verified Face or a separate gallery pick, per the user's
 * explicit choice of "either." Called once when the owner picks/changes a
 * photo, not on every /register call, so saveBusiness's routine re-saves
 * never need to re-upload or risk clobbering this with null.
 */
router.post('/:businessId/owner-photo', async (req: Request, res: Response) => {
    try {
        const { deviceId, photoBase64, photoMimeType } = req.body;
        if (!deviceId || !photoBase64) return res.status(200).json({ success: false, error: 'deviceId and photoBase64 are required' });

        const business = await Business.findOne({ where: { businessId: req.params.businessId, ownerDeviceId: deviceId } });
        if (!business) return res.status(200).json({ success: false, error: 'Business not found for this device' });

        const buffer = Buffer.from(photoBase64, 'base64');
        const url = await persistToStorage(deviceId, buffer, photoMimeType || 'image/jpeg', `business_owner_photos/${req.params.businessId}_${Date.now()}.jpg`);
        business.ownerPhotoUrl = url;
        await business.save();

        res.json({ success: true, ownerPhotoUrl: url });
    } catch (e: any) {
        logger.error(`❌ POST /business/:businessId/owner-photo error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

/**
 * Upserts the server mirror. Previously name/logo/category only — extended
 * so a business is actually browsable/contactable by OTHER users, not just
 * a thin FK anchor for Ads.
 */
router.post('/register', async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, businessId, name, description, category, address, latitude, longitude, logoUrl, connectedPlatforms, ownerName, ownerPhotoUrl } = req.body;
        if (!deviceId || !businessId || !name || !category) {
            return res.status(200).json({ success: false, error: 'deviceId, businessId, name and category are required' });
        }

        const user = await getOrCreateUserInternal(deviceId, firebaseUid);
        if (!user) {
            return res.status(200).json({ success: false, error: 'User resolve failed' });
        }

        await Business.upsert({
            businessId,
            ownerDeviceId: deviceId,
            ownerFirebaseUid: firebaseUid || null,
            name,
            description: description || null,
            category,
            address: address || null,
            latitude: latitude ?? null,
            longitude: longitude ?? null,
            logoUrl: logoUrl || null,
            connectedPlatforms: Array.isArray(connectedPlatforms) ? connectedPlatforms : [],
            ownerName: ownerName || null,
            ownerPhotoUrl: ownerPhotoUrl || null
        });

        res.json({ success: true, businessId });
    } catch (e: any) {
        logger.error(`❌ POST /business/register error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

/**
 * The cross-device business directory that never existed before — this is
 * the first endpoint that lets any user see a business someone ELSE
 * registered. `city` is a plain substring match against the free-text
 * address (no geocoding backing it, same honesty tradeoff as elsewhere in
 * this app where a real geo index isn't set up).
 *
 * When `lat`/`lon` (the SEARCHING user's own location) are supplied,
 * results are ranked by a composite of proximity and local trust: closer
 * businesses rank higher, and a business with confirmed meetups that
 * actually happened near this searcher ranks as if it were that much
 * closer still (NEARBY_MEETUP_BOOST_KM per nearby meetup) — not just
 * "has lots of meetups anywhere," specifically meetups near THIS searcher.
 */
router.get('/search', async (req: Request, res: Response) => {
    try {
        const { category, city, lat, lon } = req.query;
        const where: any = {};
        if (category && category !== 'All') where.category = category;
        if (city) {
            // Matches business name OR address against the same query —
            // previously only address/city was searchable, so searching
            // by business name silently returned nothing. Matching actual
            // inventory items (goods/services) isn't possible yet — that
            // table is still local-Room-only, never mirrored server-side.
            where[Op.or as any] = [
                { name: { [Op.iLike]: `%${city}%` } },
                { address: { [Op.iLike]: `%${city}%` } }
            ];
        }

        const businesses = await Business.findAll({ where, order: [['createdAt', 'DESC']], limit: 100 });

        // One batched count rather than N+1 per-business queries for the
        // trust-counter badge shown in the list.
        const businessIds = businesses.map(b => b.businessId);
        const meetupsByBusiness = businessIds.length === 0 ? [] : await MeetupProposal.findAll({
            where: { businessId: { [Op.in]: businessIds } },
            attributes: ['id', 'businessId', 'latitude', 'longitude']
        });
        const meetupById = new Map(meetupsByBusiness.map(m => [m.id, m]));
        const allMeetupIds = meetupsByBusiness.map(m => m.id);
        const confirmations = allMeetupIds.length === 0 ? [] : await MeetupConfirmation.findAll({
            where: { meetupId: { [Op.in]: allMeetupIds }, outcome: 'success' },
            attributes: ['meetupId']
        });
        const countByBusiness = new Map<string, number>();
        const nearbyCountByBusiness = new Map<string, number>();
        const activeAdBusinessIds = businessIds.length === 0 ? new Set<string>() : new Set(
            (await Ad.findAll({ where: { businessId: { [Op.in]: businessIds }, isActive: true }, attributes: ['businessId'] }))
                .map(a => a.businessId)
        );
        const searcherLat = lat ? parseFloat(lat as string) : null;
        const searcherLon = lon ? parseFloat(lon as string) : null;
        const hasSearcherLocation = searcherLat !== null && searcherLon !== null && !isNaN(searcherLat) && !isNaN(searcherLon);

        for (const c of confirmations) {
            const meetup = meetupById.get(c.meetupId);
            if (!meetup?.businessId) continue;
            countByBusiness.set(meetup.businessId, (countByBusiness.get(meetup.businessId) || 0) + 1);
            if (hasSearcherLocation && distanceKm(searcherLat!, searcherLon!, meetup.latitude, meetup.longitude) <= NEARBY_MEETUP_RADIUS_KM) {
                nearbyCountByBusiness.set(meetup.businessId, (nearbyCountByBusiness.get(meetup.businessId) || 0) + 1);
            }
        }

        let withCounts = businesses.map(b => ({
            ...b.toJSON(),
            confirmedMeetupsCount: countByBusiness.get(b.businessId) || 0,
            hasActiveAd: activeAdBusinessIds.has(b.businessId),
            distanceKm: hasSearcherLocation && b.latitude !== null && b.longitude !== null
                ? distanceKm(searcherLat!, searcherLon!, b.latitude, b.longitude)
                : null
        }));

        if (hasSearcherLocation) {
            withCounts = withCounts.sort((a, b) => {
                // Lower is better — raw distance minus a boost per nearby
                // confirmed meetup (earned local trust) and a bigger boost
                // for an active paid ad, so a business with either can
                // out-rank one that's merely a bit closer with neither.
                const scoreA = (a.distanceKm ?? 99999) - (nearbyCountByBusiness.get(a.businessId) || 0) * NEARBY_MEETUP_BOOST_KM - (a.hasActiveAd ? AD_BOOST_KM : 0);
                const scoreB = (b.distanceKm ?? 99999) - (nearbyCountByBusiness.get(b.businessId) || 0) * NEARBY_MEETUP_BOOST_KM - (b.hasActiveAd ? AD_BOOST_KM : 0);
                return scoreA - scoreB;
            });
        } else {
            // No searcher location to rank by proximity at all — an active
            // ad is still a meaningful signal to lead with, falling back to
            // the existing createdAt DESC order otherwise.
            withCounts = withCounts.sort((a, b) => (b.hasActiveAd ? 1 : 0) - (a.hasActiveAd ? 1 : 0));
        }

        // External fallback — only when nothing native matches (not on
        // every search) to stay well inside Geoapify's free-tier daily cap,
        // which is also exactly the intended "fallback" semantics: never
        // dead-end a search just because no registered business covers it
        // yet, but don't crowd out native results when they exist. Needs a
        // searcher location since Geoapify is a radius search, not a
        // category/name match — no lat/lon means no external results.
        let externalBusinesses: any[] = [];
        if (withCounts.length === 0 && hasSearcherLocation) {
            const discoveryCategory = (category && category !== 'All') ? String(category) : (city ? String(city) : 'markets');
            const outcome = await getNearbyPlaces(searcherLat!, searcherLon!, SEARCH_EXTERNAL_RADIUS_METERS, discoveryCategory);
            externalBusinesses = outcome.results.map(r => ({ ...r, source: 'external' }));
        }

        res.json({ success: true, businesses: withCounts, externalBusinesses });
    } catch (e: any) {
        logger.error(`❌ GET /business/search error: ${e.message}`);
        res.status(200).json({ success: false, businesses: [], externalBusinesses: [], error: e.message });
    }
});

/**
 * Single business detail, including the "confirmed meetups" trust count —
 * derived from MeetupConfirmation rows (outcome='success'), not from
 * MeetupProposal.status, since a proposal can look "completed" to one side
 * while the other party never actually confirmed anything at the meeting.
 */
router.get('/:businessId', async (req: Request, res: Response) => {
    try {
        const business = await Business.findByPk(req.params.businessId);
        if (!business) return res.status(200).json({ success: false, error: 'Business not found' });

        const meetupIds = (await MeetupProposal.findAll({ where: { businessId: req.params.businessId }, attributes: ['id'] })).map(m => m.id);
        const successfulConfirmations = meetupIds.length === 0 ? [] : await MeetupConfirmation.findAll({
            where: { meetupId: { [Op.in]: meetupIds }, outcome: 'success' }
        });

        const upvotes = successfulConfirmations.filter(c => c.buyerVote === 'up').length;
        const downvotes = successfulConfirmations.filter(c => c.buyerVote === 'down').length;
        const testimonials = successfulConfirmations
            .filter(c => c.reviewText && c.reviewText.trim().length > 0)
            .map(c => ({ reviewText: c.reviewText, confirmedAt: c.confirmedAt }));

        res.json({
            success: true,
            business,
            confirmedMeetupsCount: successfulConfirmations.length,
            upvotes,
            downvotes,
            testimonials
        });
    } catch (e: any) {
        logger.error(`❌ GET /business/:businessId error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

/**
 * 3rd-party sharing gate: a user can only recommend a business to someone
 * else once they've actually had a confirmed, successful meetup with it —
 * not before.
 */
router.get('/:businessId/can-share', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, canShare: false, error: 'deviceId required' });

        const meetupIds = (await MeetupProposal.findAll({
            where: { businessId: req.params.businessId, proposerDeviceId: deviceId },
            attributes: ['id']
        })).map(m => m.id);
        const confirmed = meetupIds.length === 0 ? 0 : await MeetupConfirmation.count({
            where: { meetupId: { [Op.in]: meetupIds }, deviceId, outcome: 'success' }
        });

        res.json({ success: true, canShare: confirmed > 0 });
    } catch (e: any) {
        res.status(200).json({ success: false, canShare: false, error: e.message });
    }
});

export default router;
