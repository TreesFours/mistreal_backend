import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A live host->viewers screencast/share session. The row is a discovery +
 * bookkeeping record only — the actual video/audio never touches this
 * server; WebRTC peers negotiate directly (or via a TURN relay) once
 * watchSignalingService.ts has handed them each other's offer/answer/ICE
 * candidates over Socket.IO. contextType/contextId let the Market or a
 * Meetup chat surface "live now" without this feature knowing anything
 * about businesses or meetups itself.
 */
export class WatchSession extends Model {
    public id!: string; // random token, used as the Socket.IO room name
    public hostDeviceId!: string;
    public contextType!: string; // 'standalone' | 'market' | 'meetup'
    public contextId!: string | null; // businessId or meetupId when relevant
    public status!: string; // 'live' | 'ended'
    public endedAt!: Date | null;
}

WatchSession.init({
    id: { type: DataTypes.STRING, primaryKey: true },
    hostDeviceId: { type: DataTypes.STRING, allowNull: false },
    contextType: { type: DataTypes.STRING, allowNull: false, defaultValue: 'standalone' },
    contextId: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'live' },
    endedAt: { type: DataTypes.DATE, allowNull: true }
}, {
    sequelize,
    modelName: 'WatchSession',
    tableName: 'WatchSessions'
});
