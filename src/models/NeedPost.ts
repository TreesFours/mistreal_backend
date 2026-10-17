import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A want-ad posted into the community ("I need an electrician") —
 * location-tagged, ephemeral (closable once fulfilled). Distinct from
 * CommunityPost (that's opt-in re-posting of a user's own social-platform
 * content, a completely different purpose) and from UserSkill (that's the
 * persistent offer side of the same match, not a post at all).
 */
export class NeedPost extends Model {
    public id!: number;
    public deviceId!: string;
    public skillLabel!: string; // stored lowercased, matched against UserSkill.skillLabel
    public description!: string | null;
    public latitude!: number;
    public longitude!: number;
    public status!: string; // 'open' | 'closed'
}

NeedPost.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    skillLabel: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    latitude: { type: DataTypes.FLOAT, allowNull: false },
    longitude: { type: DataTypes.FLOAT, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'open' }
}, {
    sequelize,
    modelName: 'NeedPost',
    tableName: 'NeedPosts'
});
