import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * One message in the discussion attached to a single Review — the
 * reviewer and reviewee by default, plus anyone added via
 * ReviewThreadInvite's mutual-approval flow. Scoped tightly to review
 * discussions only, not a general-purpose group-chat model.
 */
export class ReviewThreadMessage extends Model {
    public id!: number;
    public reviewId!: number;
    public senderDeviceId!: string;
    public contentText!: string;
    public createdAt!: Date;
}

ReviewThreadMessage.init({
    reviewId: { type: DataTypes.INTEGER, allowNull: false },
    senderDeviceId: { type: DataTypes.STRING, allowNull: false },
    contentText: { type: DataTypes.TEXT, allowNull: false }
}, {
    sequelize,
    modelName: 'ReviewThreadMessage',
    tableName: 'ReviewThreadMessages'
});
