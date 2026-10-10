import { User } from '../models/userModel';
import { UserAddon } from '../models/UserAddon';
import { getExtraPlatformsCount } from './addonCatalog';

export const hasAddon = async (deviceId: string, addonId: string): Promise<boolean> => {
    const row = await UserAddon.findOne({ where: { deviceId, addonId, status: 'active' } });
    return !!row;
};

/** FREE_USER_PLATFORM_LIMIT plus the extra_platforms add-on's configured bump, if active. */
export const getPlatformLimit = async (deviceId: string): Promise<number> => {
    const base = parseInt(process.env.FREE_USER_PLATFORM_LIMIT || '1', 10);
    const hasExtra = await hasAddon(deviceId, 'extra_platforms');
    return hasExtra ? base + getExtraPlatformsCount() : base;
};

/**
 * `isPro` stays as a simple derived "has at least one active add-on"
 * boolean for the coarse binary gates that never needed per-add-on
 * granularity (ad eligibility, the market-alerts free-tier gate, feed
 * filtering) — recomputed here rather than rewriting every one of those
 * call sites to be add-on-aware.
 */
export const recomputeIsPro = async (deviceId: string): Promise<boolean> => {
    const activeCount = await UserAddon.count({ where: { deviceId, status: 'active' } });
    const isPro = activeCount > 0;
    await User.update({ isPro }, { where: { deviceId } });
    return isPro;
};
