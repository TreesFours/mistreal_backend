import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A review one user leaves about another (specifically: about a business
 * owner, from that owner's business page — not about the business itself).
 * Deliberately held back, not published instantly: `publishAt` (set to 24h
 * after creation) is what gives the reviewee a real chance to see and
 * reply before anyone else can, rather than a courtesy notice with no
 * actual effect. No background sweep flips status at publishAt — every
 * read route computes effective visibility lazily (see reviewRoutes.ts),
 * since nothing needs to fire the instant that moment passes.
 *
 * `expiresAt` is unrelated to publication — it only ever gets set once the
 * reviewee replies (see ReviewThreadMessage), extending how long this
 * review stays featured/prominent, not whether it's visible at all.
 */
export class Review extends Model {
    public id!: number;
    public reviewerDeviceId!: string;
    public revieweeDeviceId!: string;
    public businessId!: string | null;
    public contentText!: string | null;
    public voiceUrl!: string | null;
    public status!: string; // 'pending' | 'published' | 'hidden'
    public publishAt!: Date;
    public expiresAt!: Date | null;
    public hiddenAt!: Date | null;
}

Review.init({
    reviewerDeviceId: { type: DataTypes.STRING, allowNull: false },
    revieweeDeviceId: { type: DataTypes.STRING, allowNull: false },
    businessId: { type: DataTypes.STRING, allowNull: true },
    contentText: { type: DataTypes.TEXT, allowNull: true },
    voiceUrl: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
    publishAt: { type: DataTypes.DATE, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    hiddenAt: { type: DataTypes.DATE, allowNull: true }
}, {
    sequelize,
    modelName: 'Review',
    tableName: 'Reviews'
});
