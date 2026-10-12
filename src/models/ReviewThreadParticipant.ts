import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Who can currently post into a Review's discussion. The reviewer and
 * reviewee rows are created alongside the Review itself; an 'invited' row
 * only ever appears once a ReviewThreadInvite has been approved by the
 * OTHER original party (not the one who proposed it) — see reviewRoutes.ts.
 */
export class ReviewThreadParticipant extends Model {
    public id!: number;
    public reviewId!: number;
    public deviceId!: string;
    public role!: string; // 'reviewer' | 'reviewee' | 'invited'
}

ReviewThreadParticipant.init({
    reviewId: { type: DataTypes.INTEGER, allowNull: false },
    deviceId: { type: DataTypes.STRING, allowNull: false },
    role: { type: DataTypes.STRING, allowNull: false }
}, {
    sequelize,
    modelName: 'ReviewThreadParticipant',
    tableName: 'ReviewThreadParticipants',
    indexes: [{ unique: true, fields: ['reviewId', 'deviceId'] }]
});
