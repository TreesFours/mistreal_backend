import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A scheduled in-person meetup proposed inside a chat (business transaction,
 * peer-to-peer, or a "comfort meet") — deliberately NOT continuous tracking,
 * just a shared plan both sides agreed to, confirmed only at the meeting
 * itself. businessId is nullable since the user's original ask covers both
 * "meet a business" and plain user-to-user meetups.
 *
 * `meetupType` splits confirmation into two different paths after this
 * point: 'business' (the original flow — each side files its own
 * after-the-fact MeetupConfirmation row, never cross-checked against the
 * other) vs. 'comfort' (personal/social meetups — both sides' LIVE location
 * gets cross-checked for actual proximity via meetupRoutes.ts's
 * comfort-ping endpoint, confirmed jointly in ComfortMeetConfirmation, not
 * self-reported). A comfort meetup needs counterpartyDeviceId actually set
 * (unlike the business flow, which may DM a non-app user who never has
 * one) since proximity-matching requires knowing who the other device is.
 */
export class MeetupProposal extends Model {
    public id!: number;
    public businessId!: string | null;
    public proposerDeviceId!: string;
    public counterpartyPlatform!: string | null;
    public counterpartyContactId!: string | null;
    public counterpartyDeviceId!: string | null;
    public meetupType!: string; // 'business' | 'comfort'
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
    meetupType: { type: DataTypes.STRING, allowNull: false, defaultValue: 'business' },
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
