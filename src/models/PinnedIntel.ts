import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

export class PinnedIntel extends Model {
    public id!: number;
    public firebaseUid!: string;
    public itemTitle!: string;
    public itemUrl!: string;
    public itemType!: string; // 'news', 'novel', 'astro', 'social'
    public metadata!: any;
}

PinnedIntel.init({
    firebaseUid: { type: DataTypes.STRING, allowNull: false },
    itemTitle: { type: DataTypes.STRING, allowNull: false },
    itemUrl: { type: DataTypes.STRING, allowNull: false },
    itemType: { type: DataTypes.STRING, allowNull: false },
    metadata: { type: DataTypes.JSONB, defaultValue: {} }
}, {
    sequelize,
    modelName: 'PinnedIntel',
    tableName: 'PinnedIntels'
});

export { sequelize };
