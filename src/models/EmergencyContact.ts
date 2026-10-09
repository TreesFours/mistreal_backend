import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Replaces the old `User.emergencyContacts` JSONB blob (one-directional —
 * the owner just typed/picked a name, the contact was never notified or
 * asked). A real table lets a contact explicitly confirm or decline the
 * role via confirmToken before ever receiving alert content — see
 * emergencyRoutes.ts's confirm flow.
 */
export class EmergencyContact extends Model {
    public id!: number;
    public ownerDeviceId!: string;
    public name!: string;
    public channel!: string; // 'platform' | 'email'
    public platform!: string | null;
    public platformContactId!: string | null;
    public email!: string | null;
    public status!: string; // 'pending' | 'confirmed' | 'declined'
    public confirmToken!: string;
    public invitedAt!: Date;
    public confirmedAt!: Date | null;
}

EmergencyContact.init({
    ownerDeviceId: { type: DataTypes.STRING, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    channel: { type: DataTypes.STRING, allowNull: false },
    platform: { type: DataTypes.STRING, allowNull: true },
    platformContactId: { type: DataTypes.STRING, allowNull: true },
    email: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
    confirmToken: { type: DataTypes.STRING, allowNull: false, unique: true },
    invitedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    confirmedAt: { type: DataTypes.DATE, allowNull: true }
}, {
    sequelize,
    modelName: 'EmergencyContact',
    tableName: 'EmergencyContacts'
});
