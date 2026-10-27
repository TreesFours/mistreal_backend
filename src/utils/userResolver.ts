import { User } from '../models/userModel';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Identity resolution shared by /api/chat, the BYOK AI-provider routes, and
 * most other routes in this backend. firebaseUid is the real identity once
 * a user is logged in; deviceId (ANDROID_ID) is only the fallback for fully
 * anonymous use before any login exists.
 *
 * Previously, when a firebaseUid was present but matched no row, this fell
 * through to a deviceId-only lookup — which, since ANDROID_ID survives an
 * uninstall/reinstall, meant a brand-new signup on a device that had
 * previously held a DIFFERENT account silently inherited that old
 * account's entire row (businesses, Pro status, everything), because
 * `findOrCreate({ where: { deviceId } })` found the old row instead of
 * creating a new one. A real account-isolation bug, not an edge case.
 *
 * Now: a firebaseUid that doesn't match an existing row always creates a
 * genuinely new one. The device's deviceId claim moves to the new account;
 * the old account's row keeps every field exactly as it was — it just
 * releases "this is the account for this device," which is why deviceId is
 * nullable (a unique index allows any number of NULLs, so a dormant old
 * account giving up its claim never conflicts with the new one taking it).
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

            const previousDeviceOwner = await User.findOne({ where: { deviceId } });
            if (previousDeviceOwner) {
                previousDeviceOwner.deviceId = null as any;
                await previousDeviceOwner.save();
            }

            return await User.create({ deviceId, firebaseUid, isPro: false, subscriptionTier: 'free' });
        }

        const [user] = await User.findOrCreate({
            where: { deviceId },
            defaults: { deviceId, isPro: false, subscriptionTier: 'free' }
        });
        return user;
    } catch (e) { return null; }
};
