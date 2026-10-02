import { User } from '../models/userModel';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Device-first user resolution (no login required), shared by /api/chat and
 * the BYOK AI-provider routes. Extracted from index.ts so both can use the
 * exact same lookup without duplicating it.
 */
export const getOrCreateUserInternal = async (deviceId: string, firebaseUid?: string) => {
    if (!DATABASE_URL) return null;
    try {
        if (firebaseUid) {
            const userByUid = await User.findOne({ where: { firebaseUid } });
            if (userByUid) {
                if (userByUid.deviceId !== deviceId) {
                    userByUid.deviceId = deviceId;
                    await userByUid.save();
                }
                return userByUid;
            }
        }

        const [user, created] = await User.findOrCreate({
            where: { deviceId },
            defaults: { deviceId, firebaseUid, isPro: false, subscriptionTier: 'free' }
        });

        if (!created && firebaseUid && !user.firebaseUid) {
            user.firebaseUid = firebaseUid;
            await user.save();
        }

        return user;
    } catch (e) { return null; }
};
