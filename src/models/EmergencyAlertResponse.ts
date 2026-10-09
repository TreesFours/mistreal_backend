import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A confirmed contact's response to one EmergencyAlert, reached via a link
 * whose token is an HMAC of (alertId, contactId) — see
 * emergencyRoutes.ts's signResponseToken — rather than a separately stored
 * token column, so there's nothing to generate/persist before the contact
 * ever responds. Presence of ANY row for an alert is what stops the 30-day
 * escalation sweep in index.ts from auto-posting publicly.
 */
export class EmergencyAlertResponse extends Model {
    public id!: number;
    public alertId!: number;
    public contactId!: number;
    public response!: string; // 'confirmed_safe' | 'raised_concern'
    public respondedAt!: Date;
}

EmergencyAlertResponse.init({
    alertId: { type: DataTypes.INTEGER, allowNull: false },
    contactId: { type: DataTypes.INTEGER, allowNull: false },
    response: { type: DataTypes.STRING, allowNull: false },
    respondedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
}, {
    sequelize,
    modelName: 'EmergencyAlertResponse',
    tableName: 'EmergencyAlertResponses',
    indexes: [{ unique: true, fields: ['alertId', 'contactId'] }]
});
