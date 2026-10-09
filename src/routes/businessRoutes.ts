import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { Business } from '../models/businessModel';
import { MeetupProposal } from '../models/MeetupProposal';
import { MeetupConfirmation } from '../models/MeetupConfirmation';
import logger from '../utils/logger';

const router = Router();

/**
 * Upserts the server mirror. Previously name/logo/category only — extended
 * so a business is actually browsable/contactable by OTHER users, not just
 * a thin FK anchor for Ads.
 */
router.post('/register', async (req: Request, res: Response) => {
    try {
        const { deviceId, firebaseUid, businessId, name, description, category, address, latitude, longitude, logoUrl, connectedPlatforms } = req.body;
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
            connectedPlatforms: Array.isArray(connectedPlatforms) ? connectedPlatforms : []
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
 */
router.get('/search', async (req: Request, res: Response) => {
    try {
        const { category, city } = req.query;
        const where: any = {};
        if (category && category !== 'All') where.category = category;
        if (city) where.address = { [Op.iLike]: `%${city}%` };

        const businesses = await Business.findAll({ where, order: [['createdAt', 'DESC']], limit: 100 });

        // One batched count rather than N+1 per-business queries for the
        // trust-counter badge shown in the list.
        const businessIds = businesses.map(b => b.businessId);
        const meetupsByBusiness = businessIds.length === 0 ? [] : await MeetupProposal.findAll({
            where: { businessId: { [Op.in]: businessIds } },
            attributes: ['id', 'businessId']
        });
        const meetupIdToBusinessId = new Map(meetupsByBusiness.map(m => [m.id, m.businessId]));
        const allMeetupIds = meetupsByBusiness.map(m => m.id);
        const confirmations = allMeetupIds.length === 0 ? [] : await MeetupConfirmation.findAll({
            where: { meetupId: { [Op.in]: allMeetupIds }, outcome: 'success' },
            attributes: ['meetupId']
        });
        const countByBusiness = new Map<string, number>();
        for (const c of confirmations) {
            const businessId = meetupIdToBusinessId.get(c.meetupId);
            if (businessId) countByBusiness.set(businessId, (countByBusiness.get(businessId) || 0) + 1);
        }

        const withCounts = businesses.map(b => ({ ...b.toJSON(), confirmedMeetupsCount: countByBusiness.get(b.businessId) || 0 }));
        res.json({ success: true, businesses: withCounts });
    } catch (e: any) {
        logger.error(`❌ GET /business/search error: ${e.message}`);
        res.status(200).json({ success: false, businesses: [], error: e.message });
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
        const confirmedMeetupsCount = meetupIds.length === 0 ? 0 : await MeetupConfirmation.count({
            where: { meetupId: { [Op.in]: meetupIds }, outcome: 'success' }
        });

        res.json({ success: true, business, confirmedMeetupsCount });
    } catch (e: any) {
        logger.error(`❌ GET /business/:businessId error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
