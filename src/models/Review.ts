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
 *
 * Hiding is temporary, not deletion: a 'hidden' review auto-unhides on its
 * own after 14 days (see reviewRoutes.ts's isEffectivelyVisible) — it's a
 * ceiling on suppression, not a way to make something disappear forever.
 * `exchangeCount` counts replies between ONLY the original reviewer and
 * reviewee (never an invited 3rd party) — reaching 3 force-unhides
 * immediately regardless of the 14-day timer and flips
 * `publiclyCommentable` on, opening the thread to anyone, not just
 * participants. Real permanent removal is `status: 'deleted'` via
 * POST /:id/delete, which requires a reason (`deletedReason`) shown as a
 * tombstone in place of the original content — the row itself is never
 * destroyed, kept as a permanent record (same "you can be sued if it's
 * abusive" accountability framing already built into submission).
 */
export class Review extends Model {
    public id!: number;
    public reviewerDeviceId!: string;
    public revieweeDeviceId!: string;
    public businessId!: string | null;
    public contentText!: string | null;
    public voiceUrl!: string | null;
    public status!: string; // 'pending' | 'published' | 'hidden' | 'deleted'
    public publishAt!: Date;
    public expiresAt!: Date | null;
    public hiddenAt!: Date | null;
    public exchangeCount!: number;
    public publiclyCommentable!: boolean;
    public deletedReason!: string | null;
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
    hiddenAt: { type: DataTypes.DATE, allowNull: true },
    exchangeCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    publiclyCommentable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    deletedReason: { type: DataTypes.STRING, allowNull: true }
}, {
    sequelize,
    modelName: 'Review',
    tableName: 'Reviews'
});
