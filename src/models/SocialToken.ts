// backend/src/models/SocialToken.ts
// Database model for storing social platform tokens (Sequelize)

import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db'; // Centralized database connection

export class SocialToken extends Model {
  declare deviceId: string;
  declare platform: string; // 'instagram', 'twitter', 'facebook', 'whatsapp', 'telegram'
  declare accessToken: string;
  declare refreshToken?: string;
  declare platformUserId?: string; // Platform-specific user ID
  declare expiresAt?: Date;
  declare metadata?: Record<string, any>; // Platform-specific data
  declare connectedAt: Date;
}

SocialToken.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    deviceId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'Users', key: 'deviceId' }
    },
    platform: {
      type: DataTypes.ENUM('instagram', 'twitter', 'facebook', 'whatsapp', 'telegram'),
      allowNull: false
    },
    accessToken: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    refreshToken: {
      type: DataTypes.TEXT
    },
    platformUserId: {
      type: DataTypes.STRING
    },
    expiresAt: {
      type: DataTypes.DATE
    },
    metadata: {
      type: DataTypes.JSON,
      defaultValue: {}
    },
    connectedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  },
  {
    sequelize,
    tableName: 'SocialTokens',
    timestamps: true,
    indexes: [
      { fields: ['deviceId', 'platform'], unique: true }
    ]
  }
);

export default SocialToken;
