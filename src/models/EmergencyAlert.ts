import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A fired SOS/panic event. Previously nothing persisted an alert at all —
 * it was a one-shot email+optional-broadcast with no durable record.
 *
 * `escalateAt` is legacy — it was what the old 30-day own-platform
 * escalation sweep scanned for (deleted; see index.ts history). It's left
 * in place (still written, no longer read) rather than ripped out, since
 * removing it touches every caller for no behavioral gain. The two fields
 * that actually drive escalation now are `nextCommunityBroadcastAt` (a
 * nearby Mistreal user becomes able to see this alert, minimal detail only)
 * and `fullDetailAt` (the same broadcast upgrades to exact last-known
 * location) — both computed once at creation, never advanced afterward;
 * visibility past each threshold is a live read-time check
 * (`GET /nearby-sos`), not a one-time side effect, so no sweep is needed to
 * "fire" them.
 */
export class EmergencyAlert extends Model {
    public id!: number;
    public ownerDeviceId!: string;
    public triggerType!: string; // 'manual' | 'meetup_panic'
    public latitude!: number;
    public longitude!: number;
    public sosAudioUrl!: string | null;
    public sosImageUrl!: string | null;
    public distressSignature!: string | null;
    public status!: string; // 'active' | 'resolved_safe' | 'escalated_public'
    public escalateAt!: Date;
    public nextCommunityBroadcastAt!: Date | null;
    public fullDetailAt!: Date | null;
    public resolvedAt!: Date | null;
}

EmergencyAlert.init({
    ownerDeviceId: { type: DataTypes.STRING, allowNull: false },
    triggerType: { type: DataTypes.STRING, allowNull: false },
    latitude: { type: DataTypes.FLOAT, allowNull: false },
    longitude: { type: DataTypes.FLOAT, allowNull: false },
    sosAudioUrl: { type: DataTypes.STRING, allowNull: true },
    sosImageUrl: { type: DataTypes.STRING, allowNull: true },
    distressSignature: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
    escalateAt: { type: DataTypes.DATE, allowNull: false },
    nextCommunityBroadcastAt: { type: DataTypes.DATE, allowNull: true },
    fullDetailAt: { type: DataTypes.DATE, allowNull: true },
    resolvedAt: { type: DataTypes.DATE, allowNull: true }
}, {
    sequelize,
    modelName: 'EmergencyAlert',
    tableName: 'EmergencyAlerts'
});
