import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A small curated cache, refreshed on a long interval (see youtubeService.ts)
 * rather than searched live per-request — YouTube Data API's search.list
 * costs 100 quota units against a ~10,000/day default quota, so live
 * per-user searches would exhaust it almost immediately at any real scale.
 */
export class CachedYoutubeVideo extends Model {
    public videoId!: string;
    public title!: string;
    public thumbnailUrl!: string;
    public channelTitle!: string;
    public publishedAt!: Date;
    public viewCount!: number | null;
    public likeCount!: number | null;
    public queryTag!: string;
}

CachedYoutubeVideo.init({
    videoId: { type: DataTypes.STRING, primaryKey: true },
    title: { type: DataTypes.STRING, allowNull: false },
    thumbnailUrl: { type: DataTypes.STRING, allowNull: false },
    channelTitle: { type: DataTypes.STRING, allowNull: true },
    publishedAt: { type: DataTypes.DATE, allowNull: true },
    viewCount: { type: DataTypes.BIGINT, allowNull: true },
    likeCount: { type: DataTypes.BIGINT, allowNull: true },
    queryTag: { type: DataTypes.STRING, allowNull: true }
}, {
    sequelize,
    modelName: 'CachedYoutubeVideo',
    tableName: 'CachedYoutubeVideos'
});
