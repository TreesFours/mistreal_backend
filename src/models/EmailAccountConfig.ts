import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A user's OWN email account, connected BYOK-style via IMAP/SMTP + an app
 * password — same pattern as CloudStorageConfig.ts (no OAuth app
 * registration needed, unlike Gmail API scopes, which require Google's
 * formal security review for production use). Lets the app send AS the
 * user's real address and read their real inbox, distinct from
 * EmailMessage.ts's existing send-only feature (which sends from the app's
 * own shared Gmail account, never touches an inbox).
 */
export class EmailAccountConfig extends Model {
    public id!: number;
    public deviceId!: string;
    public label!: string; // user-given friendly name, e.g. "Personal Gmail"
    public emailAddress!: string;
    public imapHost!: string;
    public imapPort!: number;
    public imapSecure!: boolean;
    public smtpHost!: string;
    public smtpPort!: number;
    public smtpSecure!: boolean;
    public username!: string; // usually == emailAddress, but some providers differ
    public encryptedPassword!: string; // AES-256-GCM via secretCrypto.ts, never plaintext
    public isActive!: boolean;
}

EmailAccountConfig.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    label: { type: DataTypes.STRING, allowNull: false },
    emailAddress: { type: DataTypes.STRING, allowNull: false },
    imapHost: { type: DataTypes.STRING, allowNull: false },
    imapPort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 993 },
    imapSecure: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    smtpHost: { type: DataTypes.STRING, allowNull: false },
    smtpPort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 465 },
    smtpSecure: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    username: { type: DataTypes.STRING, allowNull: false },
    encryptedPassword: { type: DataTypes.TEXT, allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
}, {
    sequelize,
    modelName: 'EmailAccountConfig',
    tableName: 'EmailAccountConfigs',
    indexes: [{ unique: true, fields: ['deviceId', 'label'] }]
});
