import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { Advert } from '../models/Advert';
import { Business } from '../models/businessModel';
import { persistToStorage } from './adRoutes';
import logger from '../utils/logger';

const router = Router();

// Business-only posting (confirmed: reuses the existing Business → Owner
// Profile link, matches the original "tap an advert, land on the
// advertiser's business page" vision with zero ambiguity about where a
// personal-user advert would even point).
router.post('/', async (req: Request, res: Response) => {
    try {
        const { deviceId, businessId, title, description, price, category, imageUrl, imageBase64, imageMimeType } = req.body;
        if (!deviceId || !businessId || !title || !category) {
            return res.status(200).json({ success: false, error: 'deviceId, businessId, title and category are required' });
        }

        const business = await Business.findOne({ where: { businessId } });
        if (!business) {
            return res.status(200).json({ success: false, error: 'Business not found' });
        }
        if (business.ownerDeviceId !== deviceId) {
            return res.status(200).json({ success: false, error: 'This business is not registered to this device' });
        }

        // Same base64-upload pattern as business owner-photo/logo —
        // imageUrl (already-hosted) wins if both are somehow sent; imageBase64
        // is the real client path (no image picker produces a URL directly).
        let resolvedImageUrl: string | null = imageUrl || null;
        if (!resolvedImageUrl && imageBase64) {
            const buffer = Buffer.from(imageBase64, 'base64');
            resolvedImageUrl = await persistToStorage(deviceId, buffer, imageMimeType || 'image/jpeg', `advert_images/${businessId}_${Date.now()}.jpg`);
        }

        const advert = await Advert.create({
            businessId,
            title,
            description: description || null,
            price: price || null,
            category,
            imageUrl: resolvedImageUrl
        });

        res.json({ success: true, advert });
    } catch (e: any) {
        logger.error(`❌ POST /adverts error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

// Newest-first, joins Business so the client gets everything needed to
// render the card AND navigate to the owner profile in one response — no
// second round-trip per card the way a bare Advert list would need.
router.get('/', async (req: Request, res: Response) => {
    try {
        const { category, maxPrice, limit, offset } = req.query;

        const where: any = { status: 'active' };
        if (category && category !== 'All') where.category = category;

        const adverts = await Advert.findAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: limit ? parseInt(String(limit), 10) : 30,
            offset: offset ? parseInt(String(offset), 10) : 0
        });

        const businessIds = [...new Set(adverts.map((a: any) => a.businessId))];
        const businesses = await Business.findAll({ where: { businessId: { [Op.in]: businessIds } } });
        const businessById = new Map(businesses.map((b: any) => [b.businessId, b]));

        const items = adverts
            .map((a: any) => {
                const business = businessById.get(a.businessId);
                if (!business) return null; // orphaned advert (business deleted) — skip, don't show a dead link
                return {
                    id: a.id,
                    businessId: a.businessId,
                    title: a.title,
                    description: a.description,
                    price: a.price,
                    category: a.category,
                    imageUrl: a.imageUrl,
                    createdAt: a.createdAt,
                    ownerDeviceId: business.ownerDeviceId,
                    ownerName: business.ownerName || business.name,
                    ownerPhotoUrl: business.ownerPhotoUrl || business.logoUrl
                };
            })
            .filter((it: any) => it !== null && (!maxPrice || !it.price || parseFloat(it.price) <= parseFloat(String(maxPrice))));

        res.json({ success: true, adverts: items });
    } catch (e: any) {
        logger.error(`❌ GET /adverts error: ${e.message}`);
        res.status(200).json({ success: false, adverts: [], error: e.message });
    }
});

// Owner-only status update (mark sold / remove) — ownership re-checked via
// the Advert's own businessId, same pattern as the create route above.
router.patch('/:id', async (req: Request, res: Response) => {
    try {
        const { deviceId, status } = req.body;
        if (!deviceId || !status) {
            return res.status(200).json({ success: false, error: 'deviceId and status are required' });
        }
        if (!['active', 'sold', 'removed'].includes(status)) {
            return res.status(200).json({ success: false, error: 'status must be active, sold, or removed' });
        }

        const advert = await Advert.findOne({ where: { id: req.params.id } });
        if (!advert) return res.status(200).json({ success: false, error: 'Advert not found' });

        const business = await Business.findOne({ where: { businessId: advert.businessId } });
        if (!business || business.ownerDeviceId !== deviceId) {
            return res.status(200).json({ success: false, error: 'Not authorized to update this advert' });
        }

        advert.status = status;
        await advert.save();
        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ PATCH /adverts/${req.params.id} error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
