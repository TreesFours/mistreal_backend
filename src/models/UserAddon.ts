import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Replaces the fixed-tier model (premium1/premium2, the dead Stripe
 * ai_plus/social_plus/elite tiers) — a user now accumulates whichever
 * individual add-ons they want (ai_pro, extra_platforms,
 * sms_notifications, ...) rather than picking one bundle. One row per
 * add-on per device; re-purchasing the same add-on upserts this row
 * rather than duplicating it.
 *
 * `provider` tracks WHICH rail granted this row — an install from the Play
 * Store uses Play Billing (required there); any other install source uses
 * Stripe directly (see billingRail.ts for the install-source detection this
 * is downstream of). hasAddon()/recomputeIsPro() don't care which provider
 * granted a row — both read the same table the same way.
 */
export class UserAddon extends Model {
    public id!: number;
    public deviceId!: string;
    public addonId!: string; // 'ai_pro' | 'extra_platforms' | 'sms_notifications'
    public status!: string; // 'active' | 'canceled'
    public provider!: string; // 'play' | 'stripe'
    public playProductId!: string | null;
    public playPurchaseToken!: string | null;
    public stripeCustomerId!: string | null;
    public stripeSubscriptionId!: string | null;
    public expiresAt!: Date | null;
}

UserAddon.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    addonId: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
    provider: { type: DataTypes.STRING, allowNull: false, defaultValue: 'play' },
    playProductId: { type: DataTypes.STRING, allowNull: true },
    playPurchaseToken: { type: DataTypes.STRING, allowNull: true },
    stripeCustomerId: { type: DataTypes.STRING, allowNull: true },
    stripeSubscriptionId: { type: DataTypes.STRING, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true }
}, {
    sequelize,
    modelName: 'UserAddon',
    tableName: 'UserAddons',
    indexes: [{ unique: true, fields: ['deviceId', 'addonId'] }]
});
