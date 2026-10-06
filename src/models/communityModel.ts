import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Posts shared into the in-app "Community Feed" — kept deliberately separate
 * from SocialEvent (which backs DM history/contacts/unread badges) so this
 * cross-user visibility concept can never leak into those. A row only ever
 * exists here when the author explicitly opted a specific post in
 * (shareToCommunity: true at send time) — opt-in, never opt-out, and never
 * retroactive.
 */
export class CommunityPost extends Model {
    public id!: number;
    public authorDeviceId!: string;
    public authorDisplayName!: string; // snapshot of userName, never the real platform handle
    public platform!: string;
    public content!: string;
    public imageUrl!: string | null;
    public videoUrl!: string | null;
    public sourceUrl!: string | null;
    public visibility!: string; // 'private' | 'public_app'
    public externalId!: string | null;
}

CommunityPost.init({
    authorDeviceId: { type: DataTypes.STRING, allowNull: false },
    authorDisplayName: { type: DataTypes.STRING, allowNull: false },
    platform: { type: DataTypes.STRING, allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: true },
    imageUrl: { type: DataTypes.STRING, allowNull: true },
    videoUrl: { type: DataTypes.STRING, allowNull: true },
    sourceUrl: { type: DataTypes.STRING, allowNull: true },
    visibility: { type: DataTypes.STRING, allowNull: false, defaultValue: 'public_app' },
    externalId: { type: DataTypes.STRING, allowNull: true }
}, {
    sequelize,
    modelName: 'CommunityPost',
    tableName: 'CommunityPosts'
});
