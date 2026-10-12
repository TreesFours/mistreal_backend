import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A proposal by one original party (reviewer or reviewee) to let a 3rd
 * device join a Review's discussion — only approvable by the OTHER
 * original party, never by the proposer themselves. Approval is what
 * creates the corresponding ReviewThreadParticipant row.
 */
export class ReviewThreadInvite extends Model {
    public id!: number;
    public reviewId!: number;
    public invitedDeviceId!: string;
    public proposedByDeviceId!: string;
    public status!: string; // 'pending' | 'approved' | 'declined'
}

ReviewThreadInvite.init({
    reviewId: { type: DataTypes.INTEGER, allowNull: false },
    invitedDeviceId: { type: DataTypes.STRING, allowNull: false },
    proposedByDeviceId: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' }
}, {
    sequelize,
    modelName: 'ReviewThreadInvite',
    tableName: 'ReviewThreadInvites'
});
