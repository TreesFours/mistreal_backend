import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { Review } from '../models/Review';
import { ReviewThreadMessage } from '../models/ReviewThreadMessage';
import { ReviewThreadParticipant } from '../models/ReviewThreadParticipant';
import { ReviewThreadInvite } from '../models/ReviewThreadInvite';
import { getOrCreateUserInternal } from '../utils/userResolver';
import { persistToStorage } from './adRoutes';
import logger from '../utils/logger';

const router = Router();

const REVIEW_HOLD_BACK_MS = parseFloat(process.env.REVIEW_HOLD_BACK_MS || String(24 * 60 * 60 * 1000)); // 24h
const REVIEW_REPLY_EXTENSION_MS = parseFloat(process.env.REVIEW_REPLY_EXTENSION_MS || String(14 * 24 * 60 * 60 * 1000)); // 14 days

// A 'pending' review becomes visible once publishAt passes — computed here
// rather than via a background sweep, since nothing time-sensitive needs to
// fire the instant that moment arrives (the reviewee's notice already
// happened at creation; this is just a read-time visibility check).
const isEffectivelyVisible = (review: Review): boolean => {
    if (review.status === 'hidden') return false;
    if (review.status === 'published') return true;
    return review.status === 'pending' && review.publishAt.getTime() <= Date.now();
};

router.post('/', async (req: Request, res: Response) => {
    try {
        const { reviewerDeviceId, revieweeDeviceId, businessId, firebaseUid, contentText, voiceBase64, voiceMimeType } = req.body;
        if (!reviewerDeviceId || !revieweeDeviceId || (!contentText && !voiceBase64)) {
            return res.status(200).json({ success: false, error: 'reviewerDeviceId, revieweeDeviceId and either contentText or voiceBase64 are required' });
        }
        if (reviewerDeviceId === revieweeDeviceId) {
            return res.status(200).json({ success: false, error: "You can't review yourself" });
        }

        const user = await getOrCreateUserInternal(reviewerDeviceId, firebaseUid);
        if (!user) return res.status(200).json({ success: false, error: 'User resolve failed' });

        let voiceUrl: string | null = null;
        if (voiceBase64) {
            try {
                const buffer = Buffer.from(voiceBase64, 'base64');
                voiceUrl = await persistToStorage(reviewerDeviceId, buffer, voiceMimeType || 'audio/m4a', `review_voice/${reviewerDeviceId}_${Date.now()}.m4a`);
            } catch (e: any) {
                logger.warn(`⚠️ Review voice upload failed (review still recorded without audio): ${e.message}`);
            }
        }

        const review = await Review.create({
            reviewerDeviceId, revieweeDeviceId,
            businessId: businessId || null,
            contentText: contentText || null,
            voiceUrl,
            status: 'pending',
            publishAt: new Date(Date.now() + REVIEW_HOLD_BACK_MS)
        });

        await ReviewThreadParticipant.bulkCreate([
            { reviewId: review.id, deviceId: reviewerDeviceId, role: 'reviewer' },
            { reviewId: review.id, deviceId: revieweeDeviceId, role: 'reviewee' }
        ]);

        res.json({ success: true, review });
    } catch (e: any) {
        logger.error(`❌ POST /reviews error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

// The reviewee's actual "notice" — a persisted record they can act on
// whenever they next open the app, not an ephemeral local-only message.
router.get('/pending', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, reviews: [], error: 'deviceId required' });
        const reviews = await Review.findAll({
            where: { revieweeDeviceId: deviceId, status: 'pending' },
            order: [['createdAt', 'DESC']]
        });
        res.json({ success: true, reviews });
    } catch (e: any) {
        res.status(200).json({ success: false, reviews: [], error: e.message });
    }
});

router.get('/', async (req: Request, res: Response) => {
    try {
        const revieweeDeviceId = req.query.revieweeDeviceId as string;
        if (!revieweeDeviceId) return res.status(200).json({ success: false, reviews: [], error: 'revieweeDeviceId required' });
        const all = await Review.findAll({ where: { revieweeDeviceId }, order: [['createdAt', 'DESC']] });
        res.json({ success: true, reviews: all.filter(isEffectivelyVisible) });
    } catch (e: any) {
        res.status(200).json({ success: false, reviews: [], error: e.message });
    }
});

router.post('/:id/hide', async (req: Request, res: Response) => {
    try {
        const { deviceId } = req.body;
        const review = await Review.findByPk(req.params.id);
        if (!review) return res.status(200).json({ success: false, error: 'Review not found' });
        if (deviceId !== review.revieweeDeviceId) {
            return res.status(200).json({ success: false, error: 'Only the reviewee can hide a review' });
        }
        review.status = 'hidden';
        review.hiddenAt = new Date();
        await review.save();
        res.json({ success: true });
    } catch (e: any) {
        logger.error(`❌ POST /reviews/:id/hide error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/:id/thread', async (req: Request, res: Response) => {
    try {
        const review = await Review.findByPk(req.params.id);
        if (!review) return res.status(200).json({ success: false, error: 'Review not found' });
        const [messages, participants] = await Promise.all([
            ReviewThreadMessage.findAll({ where: { reviewId: review.id }, order: [['createdAt', 'ASC']] }),
            ReviewThreadParticipant.findAll({ where: { reviewId: review.id } })
        ]);
        res.json({ success: true, messages, participants });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

router.post('/:id/reply', async (req: Request, res: Response) => {
    try {
        const { deviceId, contentText } = req.body;
        if (!deviceId || !contentText) {
            return res.status(200).json({ success: false, error: 'deviceId and contentText are required' });
        }
        const review = await Review.findByPk(req.params.id);
        if (!review) return res.status(200).json({ success: false, error: 'Review not found' });

        const isParticipant = await ReviewThreadParticipant.findOne({ where: { reviewId: review.id, deviceId } });
        if (!isParticipant) {
            return res.status(200).json({ success: false, error: 'This device is not part of this review thread' });
        }

        const message = await ReviewThreadMessage.create({ reviewId: review.id, senderDeviceId: deviceId, contentText });

        // Only the reviewee's own reply extends how long this stays
        // featured — the reviewer (or an invited 3rd party) replying has no
        // such effect.
        if (deviceId === review.revieweeDeviceId) {
            const extendedTo = new Date(Date.now() + REVIEW_REPLY_EXTENSION_MS);
            const currentExpiry = review.expiresAt?.getTime() ?? 0;
            if (extendedTo.getTime() > currentExpiry) {
                review.expiresAt = extendedTo;
                await review.save();
            }
        }

        res.json({ success: true, message });
    } catch (e: any) {
        logger.error(`❌ POST /reviews/:id/reply error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.post('/:id/invite', async (req: Request, res: Response) => {
    try {
        const { deviceId, invitedDeviceId } = req.body;
        if (!deviceId || !invitedDeviceId) {
            return res.status(200).json({ success: false, error: 'deviceId and invitedDeviceId are required' });
        }
        const review = await Review.findByPk(req.params.id);
        if (!review) return res.status(200).json({ success: false, error: 'Review not found' });
        if (deviceId !== review.reviewerDeviceId && deviceId !== review.revieweeDeviceId) {
            return res.status(200).json({ success: false, error: 'Only the reviewer or reviewee can propose an invite' });
        }

        const invite = await ReviewThreadInvite.create({
            reviewId: review.id, invitedDeviceId, proposedByDeviceId: deviceId, status: 'pending'
        });
        res.json({ success: true, invite });
    } catch (e: any) {
        logger.error(`❌ POST /reviews/:id/invite error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

// Only the OTHER original party (not whoever proposed it) can approve —
// this is the actual "mutual agreement" the invite is supposed to require.
router.post('/:id/invite/:inviteId/respond', async (req: Request, res: Response) => {
    try {
        const { deviceId, approve } = req.body;
        const review = await Review.findByPk(req.params.id);
        if (!review) return res.status(200).json({ success: false, error: 'Review not found' });
        const invite = await ReviewThreadInvite.findByPk(req.params.inviteId);
        if (!invite || invite.reviewId !== review.id) {
            return res.status(200).json({ success: false, error: 'Invite not found' });
        }
        if (invite.status !== 'pending') {
            return res.status(200).json({ success: false, error: `Invite already ${invite.status}` });
        }

        const otherParty = invite.proposedByDeviceId === review.reviewerDeviceId ? review.revieweeDeviceId : review.reviewerDeviceId;
        if (deviceId !== otherParty) {
            return res.status(200).json({ success: false, error: 'Only the other original participant can respond to this invite' });
        }

        invite.status = approve ? 'approved' : 'declined';
        await invite.save();

        if (approve) {
            await ReviewThreadParticipant.findOrCreate({
                where: { reviewId: review.id, deviceId: invite.invitedDeviceId },
                defaults: { reviewId: review.id, deviceId: invite.invitedDeviceId, role: 'invited' }
            });
        }

        res.json({ success: true, invite });
    } catch (e: any) {
        logger.error(`❌ POST /reviews/:id/invite/:inviteId/respond error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;
