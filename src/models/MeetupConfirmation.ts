import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * One party's check-in at the meeting itself — each side files their own
 * row (two per successful meetup), with a photo as proof, kept permanently
 * for reference. A business's "confirmed meetups" trust count (shown on
 * its profile) is derived from these, not from MeetupProposal.status alone,
 * since a proposal can be "completed" from one side's perspective while the
 * other never actually confirmed anything.
 */
export class MeetupConfirmation extends Model {
    public id!: number;
    public meetupId!: number;
    public deviceId!: string;
    public latitude!: number;
    public longitude!: number;
    public photoUrl!: string | null;
    public outcome!: string; // 'success' | 'failed'
    public reasonIfFailed!: string | null;
    public reviewText!: string | null;
    public confirmedAt!: Date;
}

MeetupConfirmation.init({
    meetupId: { type: DataTypes.INTEGER, allowNull: false },
    deviceId: { type: DataTypes.STRING, allowNull: false },
    latitude: { type: DataTypes.FLOAT, allowNull: false },
    longitude: { type: DataTypes.FLOAT, allowNull: false },
    photoUrl: { type: DataTypes.STRING, allowNull: true },
    outcome: { type: DataTypes.STRING, allowNull: false },
    reasonIfFailed: { type: DataTypes.STRING, allowNull: true },
    reviewText: { type: DataTypes.TEXT, allowNull: true },
    confirmedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
}, {
    sequelize,
    modelName: 'MeetupConfirmation',
    tableName: 'MeetupConfirmations',
    indexes: [{ unique: true, fields: ['meetupId', 'deviceId'] }]
});
