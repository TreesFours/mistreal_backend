import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * A user-configured price alert on a stock/crypto/commodity symbol.
 * Checked periodically against live quotes by marketDataService.checkAlerts()
 * — triggeredAt is set the moment the threshold is crossed, delivered stays
 * false until the device's MarketAlertWorker has actually surfaced it (a
 * chat message + local notification) and called the acknowledge endpoint.
 * Splitting "triggered" from "delivered" means a device that's offline when
 * an alert fires still sees it next time it checks in, instead of missing it.
 */
export class MarketAlert extends Model {
    public id!: number;
    public deviceId!: string;
    public firebaseUid!: string | null;
    public symbol!: string;
    public assetClass!: string; // 'stock' | 'crypto' | 'commodity'
    public direction!: string; // 'above' | 'below'
    public targetPrice!: number;
    public currency!: string;
    public active!: boolean;
    public triggeredAt!: Date | null;
    public triggeredPrice!: number | null;
    public delivered!: boolean;
    public createdAt!: Date;
}

MarketAlert.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    firebaseUid: { type: DataTypes.STRING, allowNull: true },
    symbol: { type: DataTypes.STRING, allowNull: false },
    assetClass: { type: DataTypes.STRING, allowNull: false },
    direction: { type: DataTypes.STRING, allowNull: false },
    targetPrice: { type: DataTypes.FLOAT, allowNull: false },
    currency: { type: DataTypes.STRING, defaultValue: 'USD' },
    active: { type: DataTypes.BOOLEAN, defaultValue: true },
    triggeredAt: { type: DataTypes.DATE, allowNull: true },
    triggeredPrice: { type: DataTypes.FLOAT, allowNull: true },
    delivered: { type: DataTypes.BOOLEAN, defaultValue: false },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
    sequelize,
    modelName: 'MarketAlert',
    tableName: 'MarketAlerts'
});
