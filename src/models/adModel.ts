import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * One ad per business — creating a new one replaces (deletes) the business's
 * prior ad and its media. The live ad isn't deleted after each display turn;
 * it auto-requeues by virtue of the rotation ordering by lastServedAt (see
 * adService.ts::getNextAd) — oldest-served goes next, so every business's ad
 * cycles back around once everyone else has had a turn.
 */
export class Ad extends Model {
    public id!: number;
    public businessId!: string;
    public ownerDeviceId!: string;
    public mediaType!: string; // 'video' | 'slideshow'
    public videoUrl!: string | null;
    public imageUrls!: string[] | null; // 6-12 entries when mediaType === 'slideshow'
    // Client-reported, not independently verified — this backend has no
    // video-inspection tooling (ffprobe) available to confirm actual length.
    public durationSeconds!: number; // 10 or 30
    public caption!: string | null;
    public targetUrl!: string | null;
    public ctaLabel!: string;
    public lastServedAt!: Date;
    public isActive!: boolean;
}

Ad.init({
    businessId: { type: DataTypes.STRING, allowNull: false, unique: true },
    ownerDeviceId: { type: DataTypes.STRING, allowNull: false },
    mediaType: { type: DataTypes.STRING, allowNull: false },
    videoUrl: { type: DataTypes.STRING, allowNull: true },
    imageUrls: { type: DataTypes.JSONB, allowNull: true },
    durationSeconds: { type: DataTypes.INTEGER, allowNull: false },
    caption: { type: DataTypes.STRING, allowNull: true },
    targetUrl: { type: DataTypes.STRING, allowNull: true },
    ctaLabel: { type: DataTypes.STRING, allowNull: false, defaultValue: 'Learn More' },
    lastServedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
}, {
    sequelize,
    modelName: 'Ad',
    tableName: 'Ads'
});

export class AdEvent extends Model {
    public id!: number;
    public adId!: number;
    public deviceId!: string;
    public eventType!: string; // 'impression' | 'engaged_click'
}

AdEvent.init({
    adId: { type: DataTypes.INTEGER, allowNull: false },
    deviceId: { type: DataTypes.STRING, allowNull: false },
    eventType: { type: DataTypes.STRING, allowNull: false }
}, {
    sequelize,
    modelName: 'AdEvent',
    tableName: 'AdEvents'
});
