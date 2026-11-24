import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * 🛍️ CLASSIFIEDS ADVERT
 * A business posts one item/commodity for sale (price, category, image) —
 * distinct from every other near-miss model checked before adding this one:
 * `Ad` (adModel.ts) is self-promotion with a unique-per-business constraint
 * (one banner, replaced on re-post) and no price/category; `BusinessItemEntity`
 * (Android Room) is the local-only inventory list that never syncs server-side;
 * `Post`/`CommunityPost` are generic text+media with zero commerce fields.
 * A business can post many Adverts (no unique constraint on businessId, unlike Ad).
 */
export class Advert extends Model {
    public id!: string;
    public businessId!: string;
    public title!: string;
    public description!: string | null;
    // Stored as a string, not DECIMAL — matches BusinessItemEntity.price's
    // existing "let the client format currency" convention rather than
    // inventing a currency/precision model this app doesn't have elsewhere.
    public price!: string | null;
    // Free string, not an enum — matches Business.category exactly (the
    // Android client's BusinessCategories list is UI-only, never enforced
    // server-side for Business either).
    public category!: string;
    public imageUrl!: string | null;
    public status!: string; // 'active' | 'sold' | 'removed'
    public createdAt!: Date;
}

Advert.init({
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    businessId: { type: DataTypes.STRING, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    price: { type: DataTypes.STRING, allowNull: true },
    category: { type: DataTypes.STRING, allowNull: false },
    imageUrl: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, defaultValue: 'active' },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
    sequelize,
    modelName: 'Advert',
    tableName: 'Adverts',
    updatedAt: false
});
