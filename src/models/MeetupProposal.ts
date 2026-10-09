import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A scheduled in-person meetup proposed inside a chat (business transaction
 * or peer-to-peer) — deliberately NOT continuous tracking, just a shared
 * plan both sides agreed to, confirmed only at the meeting itself (see
 * MeetupConfirmation). businessId is nullable since the user's original ask
 * covers both "meet a business" and plain user-to-user meetups.
 */
export class MeetupProposal extends Model {
    public id!: number;
    public businessId!: string | null;
    public proposerDeviceId!: string;
    public counterpartyPlatform!: string | null;
    public counterpartyContactId!: string | null;
    public counterpartyDeviceId!: string | null;
    public latitude!: number;
    public longitude!: number;
    public addressLabel!: string | null;
    public scheduledAt!: Date;
    public status!: string; // 'proposed' | 'accepted' | 'declined' | 'completed'
    public transactionToken!: string;
}

MeetupProposal.init({
    businessId: { type: DataTypes.STRING, allowNull: true },
    proposerDeviceId: { type: DataTypes.STRING, allowNull: false },
    counterpartyPlatform: { type: DataTypes.STRING, allowNull: true },
    counterpartyContactId: { type: DataTypes.STRING, allowNull: true },
    counterpartyDeviceId: { type: DataTypes.STRING, allowNull: true },
    latitude: { type: DataTypes.FLOAT, allowNull: false },
    longitude: { type: DataTypes.FLOAT, allowNull: false },
    addressLabel: { type: DataTypes.STRING, allowNull: true },
    scheduledAt: { type: DataTypes.DATE, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'proposed' },
    transactionToken: { type: DataTypes.STRING, allowNull: false, unique: true }
}, {
    sequelize,
    modelName: 'MeetupProposal',
    tableName: 'MeetupProposals'
});
