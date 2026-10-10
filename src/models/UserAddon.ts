import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Replaces the fixed-tier model (premium1/premium2, the dead Stripe
 * ai_plus/social_plus/elite tiers) — a user now accumulates whichever
 * individual add-ons they want (ai_pro, extra_platforms,
 * sms_notifications, ...) rather than picking one bundle. One row per
 * add-on per device; re-purchasing the same add-on upserts this row
 * rather than duplicating it.
 */
export class UserAddon extends Model {
    public id!: number;
    public deviceId!: string;
    public addonId!: string; // 'ai_pro' | 'extra_platforms' | 'sms_notifications'
    public status!: string; // 'active' | 'canceled'
    public playProductId!: string;
    public playPurchaseToken!: string;
    public expiresAt!: Date | null;
}

UserAddon.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    addonId: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
    playProductId: { type: DataTypes.STRING, allowNull: false },
    playPurchaseToken: { type: DataTypes.STRING, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: true }
}, {
    sequelize,
    modelName: 'UserAddon',
    tableName: 'UserAddons',
    indexes: [{ unique: true, fields: ['deviceId', 'addonId'] }]
});
