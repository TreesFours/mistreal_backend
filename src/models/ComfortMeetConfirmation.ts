import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * One joint confirmation event for a 'comfort' MeetupProposal — unlike
 * MeetupConfirmation (one row per device, self-reported, never cross-
 * checked), this is a single row created automatically by the backend the
 * moment both parties' live locations (meetupRoutes.ts's comfort-ping
 * endpoint) land within COMFORT_MEET_PROXIMITY_METERS of each other within
 * COMFORT_MEET_PING_WINDOW_MS of one another. Kept as its own table (not a
 * type flag on MeetupConfirmation) specifically so business trust counts
 * and comfort-meet counts never mix.
 */
export class ComfortMeetConfirmation extends Model {
    public id!: number;
    public meetupId!: number;
    public deviceIdA!: string;
    public deviceIdB!: string;
    public distanceMeters!: number;
    public confirmedAt!: Date;
}

ComfortMeetConfirmation.init({
    meetupId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    deviceIdA: { type: DataTypes.STRING, allowNull: false },
    deviceIdB: { type: DataTypes.STRING, allowNull: false },
    distanceMeters: { type: DataTypes.FLOAT, allowNull: false },
    confirmedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
}, {
    sequelize,
    modelName: 'ComfortMeetConfirmation',
    tableName: 'ComfortMeetConfirmations'
});
