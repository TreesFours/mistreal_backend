import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Browser-games catalog — each row is either an external gaming site
 * (externalUrl) or a game we host ourselves under /games-static/<hostedSlug>
 * (see gameRoutes.ts, which resolves either shape into one `playUrl` so the
 * client never has to branch on sourceType). Grows purely server-side, same
 * as the Business directory — a new row is immediately listable with no
 * app update.
 */
export class Game extends Model {
    public id!: string;
    public title!: string;
    public description!: string | null;
    public thumbnailUrl!: string | null;
    public category!: string | null;
    public sourceType!: 'external' | 'hosted';
    public externalUrl!: string | null;
    public hostedSlug!: string | null;
    public isActive!: boolean;
}

Game.init({
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    thumbnailUrl: { type: DataTypes.STRING, allowNull: true },
    category: { type: DataTypes.STRING, allowNull: true },
    sourceType: { type: DataTypes.ENUM('external', 'hosted'), allowNull: false },
    externalUrl: { type: DataTypes.STRING, allowNull: true },
    hostedSlug: { type: DataTypes.STRING, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
}, {
    sequelize,
    modelName: 'Game',
    tableName: 'Games'
});
