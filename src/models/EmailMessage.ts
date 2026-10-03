import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Sent-mail log for the drawer's compose-and-send Email feature (send-only —
 * no inbox sync/OAuth; see emailRoutes.ts). One row per message actually sent
 * via the app's own transport, so a "thread" with a given address is just
 * every row for that (deviceId, toEmail) pair ordered by timestamp.
 */
export class EmailMessage extends Model {
    public id!: number;
    public deviceId!: string;
    public toEmail!: string;
    public toName!: string | null;
    public subject!: string;
    public body!: string;
    public timestamp!: Date;
}

EmailMessage.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    toEmail: { type: DataTypes.STRING, allowNull: false },
    toName: { type: DataTypes.STRING, allowNull: true },
    subject: { type: DataTypes.STRING, allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false },
    timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
    sequelize,
    modelName: 'EmailMessage',
    tableName: 'EmailMessages'
});
