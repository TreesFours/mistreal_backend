import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A skill/service a user offers on their OWN profile (e.g. "electrician")
 * — persistent, not a post. Matched (case-insensitively, via the
 * lowercased skillLabel stored here) against NeedPost.skillLabel in
 * needRoutes.ts to surface nearby requests to the people who can fulfill
 * them. Deliberately separate from a review/reputation concept — this is
 * about what someone can DO, not what others think of them.
 */
export class UserSkill extends Model {
    public id!: number;
    public deviceId!: string;
    public skillLabel!: string; // stored lowercased
}

UserSkill.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    skillLabel: { type: DataTypes.STRING, allowNull: false }
}, {
    sequelize,
    modelName: 'UserSkill',
    tableName: 'UserSkills',
    indexes: [{ unique: true, fields: ['deviceId', 'skillLabel'] }]
});
