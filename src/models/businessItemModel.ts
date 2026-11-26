import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Server-side mirror of a business's inventory. Previously inventory was
 * local-Room-only (BusinessItemEntity) with zero backend counterpart — a
 * device other than the owner's had no way to ever see what a business
 * actually sells, since nothing synced it anywhere. Deliberately a real
 * table with its own auto-increment id, not a JSONB array on Business like
 * connectedPlatforms/connectedAdAccounts, since items are added/removed
 * individually and can grow unbounded per business.
 */
export class BusinessItem extends Model {
    public id!: number;
    public businessId!: string;
    public name!: string;
    public price!: string | null;
    public imageUrl!: string | null;
}

BusinessItem.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    businessId: { type: DataTypes.STRING, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    price: { type: DataTypes.STRING, allowNull: true },
    imageUrl: { type: DataTypes.STRING, allowNull: true }
}, {
    sequelize,
    modelName: 'BusinessItem',
    tableName: 'BusinessItems',
    indexes: [{ fields: ['businessId'] }]
});
