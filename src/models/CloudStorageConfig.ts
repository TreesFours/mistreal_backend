import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A user's OWN cloud storage account, connected BYOK-style — same spirit
 * as AiProviderConfig's saved AI-provider keys, kept as a separate table
 * rather than reusing that one since fields like "modelName" don't
 * honestly fit storage credentials. One row per saved account; `isActive`
 * marks which one (if any) persistToStorage.ts's dispatcher should use for
 * this device — at most one active row per device, enforced in
 * cloudStorageRoutes.ts's activate handler, not at the DB level.
 */
export class CloudStorageConfig extends Model {
    public id!: number;
    public deviceId!: string;
    public label!: string; // user-given friendly name, e.g. "My Nextcloud"
    public providerType!: string; // 'webdav' for now; room for 'google_drive' | 'dropbox' | 's3' later
    public baseUrl!: string;
    public username!: string;
    public encryptedPassword!: string; // AES-256-GCM via secretCrypto.ts, never plaintext
    public isActive!: boolean;
}

CloudStorageConfig.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    label: { type: DataTypes.STRING, allowNull: false },
    providerType: { type: DataTypes.STRING, allowNull: false, defaultValue: 'webdav' },
    baseUrl: { type: DataTypes.STRING, allowNull: false },
    username: { type: DataTypes.STRING, allowNull: false },
    encryptedPassword: { type: DataTypes.TEXT, allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
}, {
    sequelize,
    modelName: 'CloudStorageConfig',
    tableName: 'CloudStorageConfigs',
    indexes: [{ unique: true, fields: ['deviceId', 'label'] }]
});
