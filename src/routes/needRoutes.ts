import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { UserSkill } from '../models/UserSkill';
import { NeedPost } from '../models/NeedPost';
import { User } from '../models/userModel';
import logger from '../utils/logger';

const router = Router();

const distanceKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// --- Offered skills (persistent, on a user's own profile) ---

router.post('/skills', async (req: Request, res: Response) => {
    try {
        const { deviceId, skillLabel } = req.body;
        if (!deviceId || !skillLabel) return res.status(200).json({ success: false, error: 'deviceId and skillLabel are required' });

        const [skill] = await UserSkill.findOrCreate({
            where: { deviceId, skillLabel: String(skillLabel).toLowerCase().trim() },
            defaults: { deviceId, skillLabel: String(skillLabel).toLowerCase().trim() }
        });
        res.json({ success: true, skill });
    } catch (e: any) {
        logger.error(`❌ POST /needs/skills error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/skills', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, skills: [], error: 'deviceId required' });
        const skills = await UserSkill.findAll({ where: { deviceId }, order: [['createdAt', 'ASC']] });
        res.json({ success: true, skills });
    } catch (e: any) {
        res.status(200).json({ success: false, skills: [], error: e.message });
    }
});

router.delete('/skills/:id', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        await UserSkill.destroy({ where: { id: req.params.id, deviceId } });
        res.json({ success: true });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

// --- Need posts (ephemeral, location-tagged want-ads) ---

router.post('/', async (req: Request, res: Response) => {
    try {
        const { deviceId, skillLabel, description, latitude, longitude } = req.body;
        if (!deviceId || !skillLabel || latitude === undefined || longitude === undefined) {
            return res.status(200).json({ success: false, error: 'deviceId, skillLabel, latitude and longitude are required' });
        }
        const need = await NeedPost.create({
            deviceId,
            skillLabel: String(skillLabel).toLowerCase().trim(),
            description: description || null,
            latitude, longitude,
            status: 'open'
        });
        res.json({ success: true, need });
    } catch (e: any) {
        logger.error(`❌ POST /needs error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

// Browse nearby open needs — the community-feed view, nearest-first when
// the browsing device's own location is supplied.
router.get('/', async (req: Request, res: Response) => {
    try {
        const { lat, lon } = req.query;
        const needs = await NeedPost.findAll({ where: { status: 'open' }, order: [['createdAt', 'DESC']], limit: 100 });

        const searcherLat = lat ? parseFloat(lat as string) : null;
        const searcherLon = lon ? parseFloat(lon as string) : null;
        const hasLocation = searcherLat !== null && searcherLon !== null && !isNaN(searcherLat) && !isNaN(searcherLon);

        let withDistance = needs.map(n => ({
            ...n.toJSON(),
            distanceKm: hasLocation ? distanceKm(searcherLat!, searcherLon!, n.latitude, n.longitude) : null
        }));
        if (hasLocation) withDistance = withDistance.sort((a, b) => (a.distanceKm ?? 99999) - (b.distanceKm ?? 99999));

        res.json({ success: true, needs: withDistance });
    } catch (e: any) {
        logger.error(`❌ GET /needs error: ${e.message}`);
        res.status(200).json({ success: false, needs: [], error: e.message });
    }
});

/**
 * The polling-based "notification" — no push infrastructure exists
 * anywhere in this app, so a matching device finds out by checking this
 * next time it opens the app, same spirit as the existing pending-alerts/
 * pending-reviews polling. Ranked by distance from the need's own location
 * to THIS device's last-known location (userModel.ts's lastKnownLat/Lon,
 * populated by the client's one-shot per-session call to
 * POST /api/user/location — see MainActivity.kt).
 */
router.get('/matches', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, needs: [], error: 'deviceId required' });

        const mySkills = await UserSkill.findAll({ where: { deviceId } });
        if (mySkills.length === 0) return res.json({ success: true, needs: [] });

        const me = await User.findOne({ where: { deviceId } });
        const myLat = me?.lastKnownLat ?? null;
        const myLon = me?.lastKnownLon ?? null;

        const skillLabels = mySkills.map(s => s.skillLabel);
        const matches = await NeedPost.findAll({
            where: { status: 'open', skillLabel: { [Op.in]: skillLabels }, deviceId: { [Op.ne]: deviceId } },
            order: [['createdAt', 'DESC']]
        });

        let withDistance = matches.map(n => ({
            ...n.toJSON(),
            distanceKm: (myLat !== null && myLon !== null) ? distanceKm(myLat, myLon, n.latitude, n.longitude) : null
        }));
        withDistance = withDistance.sort((a, b) => (a.distanceKm ?? 99999) - (b.distanceKm ?? 99999));

        res.json({ success: true, needs: withDistance });
    } catch (e: any) {
        logger.error(`❌ GET /needs/matches error: ${e.message}`);
        res.status(200).json({ success: false, needs: [], error: e.message });
    }
});

router.post('/:id/close', async (req: Request, res: Response) => {
    try {
        const { deviceId } = req.body;
        const need = await NeedPost.findOne({ where: { id: req.params.id, deviceId } });
        if (!need) return res.status(200).json({ success: false, error: 'Need not found for this device' });
        need.status = 'closed';
        await need.save();
        res.json({ success: true });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
