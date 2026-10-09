import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A fired SOS/panic event. Previously nothing persisted an alert at all —
 * it was a one-shot email+optional-broadcast with no durable record. This
 * is also what the 30-day escalation sweep (index.ts) scans for: any
 * 'active' row past escalateAt with zero EmergencyAlertResponse rows gets
 * auto-posted to the owner's own connected platforms.
 */
export class EmergencyAlert extends Model {
    public id!: number;
    public ownerDeviceId!: string;
    public triggerType!: string; // 'manual' | 'meetup_panic'
    public latitude!: number;
    public longitude!: number;
    public sosAudioUrl!: string | null;
    public distressSignature!: string | null;
    public status!: string; // 'active' | 'resolved_safe' | 'escalated_public'
    public escalateAt!: Date;
    public resolvedAt!: Date | null;
}

EmergencyAlert.init({
    ownerDeviceId: { type: DataTypes.STRING, allowNull: false },
    triggerType: { type: DataTypes.STRING, allowNull: false },
    latitude: { type: DataTypes.FLOAT, allowNull: false },
    longitude: { type: DataTypes.FLOAT, allowNull: false },
    sosAudioUrl: { type: DataTypes.STRING, allowNull: true },
    distressSignature: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
    escalateAt: { type: DataTypes.DATE, allowNull: false },
    resolvedAt: { type: DataTypes.DATE, allowNull: true }
}, {
    sequelize,
    modelName: 'EmergencyAlert',
    tableName: 'EmergencyAlerts'
});
