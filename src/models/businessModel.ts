import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Minimal server-side mirror of the Business Hub feature, which otherwise
 * lives entirely in local Room storage (BusinessEntity/BusinessItemEntity).
 * Ads need a real FK to attribute spend/engagement to the right business even
 * if the business later edits its local name/logo — this table is that
 * anchor, not a full re-implementation of the local business profile.
 */
export class Business extends Model {
    public businessId!: string;
    public ownerDeviceId!: string;
    public ownerFirebaseUid!: string | null;
    public name!: string;
    public logoUrl!: string | null;
    public category!: string;
}

Business.init({
    businessId: { type: DataTypes.STRING, primaryKey: true },
    ownerDeviceId: { type: DataTypes.STRING, allowNull: false },
    ownerFirebaseUid: { type: DataTypes.STRING, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: false },
    logoUrl: { type: DataTypes.STRING, allowNull: true },
    category: { type: DataTypes.STRING, allowNull: false }
}, {
    sequelize,
    modelName: 'Business',
    tableName: 'Businesses'
});
