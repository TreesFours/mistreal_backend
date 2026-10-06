import { Op } from 'sequelize';
import { Ad, AdEvent } from '../models/adModel';
import logger from '../utils/logger';

/** At least Premium tier 1 — covers every tier vocabulary this backend
 * currently uses (subscriptionTier 'premium1'/'premium2', Stripe's 'pro',
 * or the plain isPro boolean) rather than picking just one and locking out
 * real paying customers because of the naming inconsistency between them.
 */
export const isEligibleForAds = (user: any): boolean => {
    const tier = (user.subscriptionTier || '').toLowerCase();
    return user.isPro === true || tier === 'premium1' || tier === 'premium2' || tier === 'pro';
};

interface CreateAdInput {
    businessId: string;
    ownerDeviceId: string;
    mediaType: 'video' | 'slideshow';
    videoUrl?: string;
    imageUrls?: string[];
    durationSeconds: number;
    caption?: string;
    targetUrl?: string;
    ctaLabel?: string;
}

export const createAd = async (input: CreateAdInput) => {
    if (input.mediaType === 'video') {
        if (!input.videoUrl) throw new Error('A video is required.');
        if (![10, 30].includes(input.durationSeconds)) throw new Error('Video ads must be 10 or 30 seconds.');
    } else if (input.mediaType === 'slideshow') {
        const count = input.imageUrls?.length || 0;
        if (count < 6 || count > 12) throw new Error('A slideshow needs 6 to 12 images.');
        if (![10, 30].includes(input.durationSeconds)) throw new Error('Slideshows must run for 10 or 30 seconds total.');
    } else {
        throw new Error('mediaType must be "video" or "slideshow".');
    }

    // One ad per business — replace whatever was there. The old media's
    // storage bytes are left in place (cheap, and not worth the complexity
    // of parsing a public URL back into a deletable storage path) but the
    // row itself is removed so only the current ad is ever served.
    await Ad.destroy({ where: { businessId: input.businessId } });

    return await Ad.create({
        businessId: input.businessId,
        ownerDeviceId: input.ownerDeviceId,
        mediaType: input.mediaType,
        videoUrl: input.videoUrl || null,
        imageUrls: input.imageUrls || null,
        durationSeconds: input.durationSeconds,
        caption: input.caption || null,
        targetUrl: input.targetUrl || null,
        ctaLabel: input.ctaLabel || 'Learn More',
        lastServedAt: new Date(0) // immediately eligible for its first turn
    });
};

/**
 * Round-robin, not random: whichever active ad has gone longest without a
 * turn goes next. Businesses that haven't had a turn in a while naturally
 * surface first, and a just-shown ad naturally cycles back to the end of the
 * line — this is the "auto repost" behavior, achieved purely through the
 * ordering, with no separate re-queue step needed.
 */
export const getNextAd = async (): Promise<Ad | null> => {
    const next = await Ad.findOne({
        where: { isActive: true },
        order: [['lastServedAt', 'ASC']]
    });
    if (!next) return null;
    next.lastServedAt = new Date();
    await next.save();
    return next;
};

/**
 * Per-device pacing — independent of the rotation fairness above. Caps how
 * many ad appearances a single device gets inside a rolling 12h window and
 * spaces them evenly across it, so a device doesn't see an ad right after
 * the last one just because a lot of businesses are in rotation.
 */
export const isAdDue = async (deviceId: string): Promise<boolean> => {
    const perWindow = parseInt(process.env.AD_APPEARANCES_PER_12H || '6', 10);
    if (perWindow <= 0) return false;

    const windowMs = 12 * 60 * 60 * 1000;
    const windowStart = new Date(Date.now() - windowMs);

    const recentImpressions = await AdEvent.count({
        where: { deviceId, eventType: 'impression', createdAt: { [Op.gte]: windowStart } }
    });
    if (recentImpressions >= perWindow) return false;

    const lastImpression = await AdEvent.findOne({
        where: { deviceId, eventType: 'impression' },
        order: [['createdAt', 'DESC']]
    });
    if (!lastImpression) return true;

    const minGapMs = windowMs / perWindow;
    return Date.now() - new Date((lastImpression as any).createdAt).getTime() >= minGapMs;
};

export const trackAdEvent = async (adId: number, deviceId: string, eventType: 'impression' | 'engaged_click') => {
    await AdEvent.create({ adId, deviceId, eventType });
};
