import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Saved media-generation providers a user can add and switch between — unlike
 * the single-slot BYOK fields on User (one text provider, one video-edit
 * provider), image/video GENERATION had no BYOK story at all before this:
 * "Our Recommended" (Imagen/Veo) was the only option, with no way to add a
 * different one or keep several saved and pick which is active.
 *
 * One row per saved provider; `User.activeImageGenConfigId` /
 * `activeVideoGenConfigId` point at which one (if any) is active for that
 * capability — null means "use Our Recommended."
 */
export class AiProviderConfig extends Model {
    public id!: number;
    public deviceId!: string;
    public capability!: string; // 'image_gen' | 'video_gen'
    public label!: string; // user-given friendly name, e.g. "My OpenAI Key"
    public providerType!: string; // 'openai' | 'stability' | 'runway' | 'custom' etc.
    public encryptedKey!: string; // AES-256-GCM, never plaintext
    public baseUrl!: string | null;
    public modelName!: string | null;
}

AiProviderConfig.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    capability: { type: DataTypes.STRING, allowNull: false },
    label: { type: DataTypes.STRING, allowNull: false },
    providerType: { type: DataTypes.STRING, allowNull: false },
    encryptedKey: { type: DataTypes.TEXT, allowNull: false },
    baseUrl: { type: DataTypes.STRING, allowNull: true },
    modelName: { type: DataTypes.STRING, allowNull: true }
}, {
    sequelize,
    modelName: 'AiProviderConfig',
    tableName: 'AiProviderConfigs'
});
